# 精简 AI 内置模型相关 node_modules（npm install 之后、electron-builder 打包之前执行一次）
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$nm = Join-Path $repo 'node_modules'
Write-Output '== 删除可选依赖 sharp =='
Remove-Item -Recurse -Force (Join-Path $nm 'sharp') -ErrorAction SilentlyContinue
Write-Output '== 裁剪 onnxruntime-node 非 Windows 平台 =='
$ortBin = Join-Path $nm 'onnxruntime-node\bin'
foreach ($nv in Get-ChildItem $ortBin -Directory) {
  foreach ($plat in Get-ChildItem $nv.FullName -Directory) {
    if ($plat.Name -ne 'win32') { Remove-Item -Recurse -Force $plat.FullName }
  }
}
Remove-Item -Recurse -Force (Join-Path $ortBin 'napi-v3\win32\arm64') -ErrorAction SilentlyContinue
Write-Output '== onnxruntime-web -> onnxruntime-node 轻量 shim =='
$webDir = Join-Path $nm 'onnxruntime-web'
Remove-Item -Recurse -Force $webDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $webDir | Out-Null
Set-Content -Path (Join-Path $webDir 'package.json') -Value '{"name":"onnxruntime-web","version":"1.14.0","main":"index.js"}'
Set-Content -Path (Join-Path $webDir 'index.js') -Value "module.exports = require('onnxruntime-node');"
Write-Output ('精简完成，node_modules ' + [math]::Round((Get-ChildItem $nm -Recurse -File | Measure-Object Length -Sum).Sum/1MB,1) + ' MB')
