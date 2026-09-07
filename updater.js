const { app, net, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'kaltsit-sihengtuo-companion-updater';
const INITIAL_CHECK_DELAY = 8 * 1000;
const PERIODIC_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

function parseVersion(value) {
  const text = String(value == null ? '' : value).trim().replace(/^[vV]/, '');
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: text };
}

function compareVersions(left, right) {
  if (!left || !right) return 0;
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

function pickInstallAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const executables = assets.filter((asset) => asset && asset.name && asset.name.toLowerCase().endsWith('.exe'));
  if (!executables.length) return null;
  return executables.find((asset) => /setup|installer|安装/i.test(asset.name)) || executables[0];
}

module.exports = function createUpdater({ getConfig, onStateChange, onOpenSettings, log }) {
  let firstCheckTimer = null;
  let periodicTimer = null;
  let checking = false;
  let downloading = false;
  let lastResult = null;

  function currentVersion() {
    return parseVersion(app.getVersion()) ? app.getVersion() : '0.0.0';
  }

  function configured() {
    const config = getConfig();
    return Boolean((config.updateOwner || '').trim() && (config.updateRepo || '').trim());
  }

  function snapshot(overrides = {}) {
    const config = getConfig();
    const base = {
      currentVersion: currentVersion(),
      phase: 'idle',
      latestVersion: null,
      releaseNotes: '',
      assetName: '',
      percent: null,
      message: '',
      repoOwner: (config.updateOwner || '').trim(),
      repoName: (config.updateRepo || '').trim(),
      autoEnabled: Boolean(config.autoUpdateEnabled),
      checking,
      downloading,
      candidate: lastResult && lastResult.phase === 'available' ? lastResult : null
    };
    return { ...base, ...lastResult, ...overrides };
  }

  function emit(overrides) {
    const state = snapshot(overrides);
    try { onStateChange(state); } catch (_error) {}
    return state;
  }

  function stopTimers() {
    if (firstCheckTimer) { clearTimeout(firstCheckTimer); firstCheckTimer = null; }
    if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
  }

  function scheduleAutoCheck() {
    stopTimers();
    if (!getConfig().autoUpdateEnabled || !configured()) return;
    firstCheckTimer = setTimeout(() => { checkForUpdates({ silent: true }); }, INITIAL_CHECK_DELAY);
    periodicTimer = setInterval(() => { checkForUpdates({ silent: true }); }, PERIODIC_CHECK_INTERVAL);
  }

  async function fetchLatestRelease(owner, repo) {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
    const response = await net.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (response.status === 404) {
      const error = new Error(`仓库 ${owner}/${repo} 还没有发布版本`);
      error.code = 'NO_RELEASES';
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`GitHub 返回 HTTP ${response.status}`);
      error.code = 'HTTP';
      throw error;
    }
    return response.json();
  }

  async function checkForUpdates(options = {}) {
    const manual = Boolean(options.manual) || !Boolean(options.silent);
    if (checking) return lastResult || snapshot();
    if (!configured()) {
      lastResult = emit({ phase: 'unconfigured', message: '请先在设置中填写 GitHub 仓库（owner/repo）' });
      return lastResult;
    }
    checking = true;
    emit({ phase: 'checking', message: '正在检查更新…' });
    try {
      const config = getConfig();
      const owner = (config.updateOwner || '').trim();
      const repo = (config.updateRepo || '').trim();
      const release = await fetchLatestRelease(owner, repo);
      const tag = parseVersion(release.tag_name);
      const current = parseVersion(app.getVersion());
      if (!tag) throw new Error(`无法解析版本号：${release.tag_name || '(空)'}`);

      const asset = pickInstallAsset(release);
      const isNewer = current ? compareVersions(tag.raw, current.raw) > 0 : true;

      if (!isNewer) {
        lastResult = emit({ phase: 'latest', message: `已是最新版本 v${currentVersion()}` });
        return lastResult;
      }
      if (!asset) {
        lastResult = emit({
          phase: 'no-asset',
          latestVersion: tag.raw,
          message: `发现新版本 v${tag.raw}，但该 Release 中没有可用的安装包（.exe）`
        });
        return lastResult;
      }

      lastResult = emit({
        phase: 'available',
        latestVersion: tag.raw,
        releaseNotes: String(release.body || '').slice(0, 400),
        assetName: asset.name,
        assetUrl: asset.browser_download_url,
        assetSize: asset.size || 0,
        message: ''
      });
      try { log('update-available', { latest: tag.raw, asset: asset.name, manual }); } catch (_error) {}
      if (!manual) notifyAvailable(tag.raw);
      return lastResult;
    } catch (error) {
      lastResult = emit({
        phase: 'error',
        message: error.code === 'NO_RELEASES' ? error.message : `检查更新失败：${error.message || String(error)}`
      });
      try { log('update-check-error', { error: error.message, manual }); } catch (_error) {}
      return lastResult;
    } finally {
      checking = false;
    }
  }

  function notifyAvailable(version) {
    try {
      const notification = new Notification({
        title: '发现新版本',
        body: `${getConfig().productName || app.getName()} 有可用更新 v${version}，点击查看。`
      });
      notification.on('click', () => { try { onOpenSettings(); } catch (_error) {} });
      notification.show();
    } catch (_error) {}
  }

  async function downloadAsset(assetUrl, targetPath, onProgress) {
    const response = await net.fetch(assetUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }
    });
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const file = fs.createWriteStream(targetPath);
    let received = 0;
    let lastEmitAt = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          received += value.length;
          file.write(Buffer.from(value));
        }
        const now = Date.now();
        if (now - lastEmitAt > 200 || done) {
          lastEmitAt = now;
          onProgress({ received, total, percent: total ? Math.min(100, (received / total) * 100) : 0 });
        }
      }
      await new Promise((resolve, reject) => {
        file.on('finish', resolve);
        file.on('error', reject);
        file.end();
      });
    } finally {
      try { reader.cancel(); } catch (_error) {}
    }
    return received;
  }

  async function downloadAndInstall() {
    if (!lastResult || lastResult.phase !== 'available' || downloading) {
      emit({ message: '没有可安装的更新，请先检查更新' });
      return false;
    }
    const candidate = lastResult;
    const safeName = String(candidate.assetName || 'update.exe').replace(/[\\/:*?"<>|]/g, '_');
    const targetDir = path.join(app.getPath('userData'), 'updates');
    const targetPath = path.join(targetDir, safeName);
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (_error) {}
    downloading = true;
    emit({ phase: 'downloading', message: `正在下载 ${candidate.assetName}…`, percent: 0 });
    try {
      const received = await downloadAsset(candidate.assetUrl, targetPath, ({ percent }) => {
        emit({ phase: 'downloading', message: `正在下载 ${candidate.assetName}…`, percent: Math.round(percent) });
      });
      log('update-downloaded', { asset: candidate.assetName, bytes: received, path: targetPath });
      emit({ phase: 'downloaded', message: '下载完成，即将安装并重启', percent: 100 });
      setTimeout(() => applyInstaller(targetPath), 600);
      return true;
    } catch (error) {
      log('update-download-error', { error: error.message });
      emit({ phase: 'error', message: `下载失败：${error.message || String(error)}` });
      return false;
    } finally {
      downloading = false;
    }
  }

  function applyInstaller(installerPath) {
    try {
      log('update-launch-installer', { installerPath });
      const child = spawn(installerPath, ['--updated', '/S'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', (error) => {
        log('update-launch-installer-error', { error: error.message });
        emit({ phase: 'error', message: `启动安装程序失败：${error.message}` });
      });
      child.unref();
      setTimeout(() => {
        try { app.quit(); } catch (_error) {}
      }, 2000);
    } catch (error) {
      log('update-launch-installer-error', { error: error.message });
      emit({ phase: 'error', message: `启动安装程序失败：${error.message}` });
    }
  }

  return {
    checkForUpdates,
    downloadAndInstall,
    getState: () => snapshot(),
    applyConfig() {
      scheduleAutoCheck();
    },
    stop() {
      stopTimers();
    }
  };
};
