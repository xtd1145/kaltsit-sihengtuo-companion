# 凯尔希-思衡托桌宠（Kaltsit SiHengTuo Desktop Pet）

> 一个可以常驻桌面的同人桌宠：凯尔希-思衡托桌面伴侣。

## 致谢 🙏

本项目能够成形，离不开以下两位老师的付出：

- **制作：@希fei（bilibili），本人仓库为https://github.com/xihuii17/fangzhou-desktop-pets**
- **图画制作：@夏雪NazuYuki（bilibili）**

桌宠使用的 GIF 表情素材均来自 **@夏雪NazuYuki** 老师。老师产出非常多好看的表情包，观众姥爷们感兴趣可以点点关注～

## 贡献者

感谢以下开发者对本项目的支持与贡献：

- [xihuii17](https://github.com/xihuii17) — [fangzhou-desktop-pets](https://github.com/xihuii17/fangzhou-desktop-pets)

> 想一起完善桌宠？欢迎提交 Issue / PR，共同把这个同人桌宠做得更好。

## 简介

她可以常驻桌面，陪你摸鱼、陪你专注。支持**点击、双击和长按互动**，也可以**拖动**她到屏幕的任意位置；点击或右键即可呼出快捷菜单。

- 🖱️ 点击 / 双击 / 长按触发随机互动动作，拖动时也有对应动作和落点反馈
- ☀️☁️🌙 **安静 / 日常 / 办公** 三种模式一键切换，不同模式下她会做不同的事情
- 🎞️ 内置**统一的 GIF 素材库**：自带大量动作与表情
- 📦 支持**导入自己的素材**、修改动作名称与互动文字，自由组合每种模式使用的动作
- 💬 互动文字气泡、大小调节、总在最前、开机自启
- 🎯 **鼠标穿透**：开启后桌宠不再拦截鼠标，点击会穿透到背后的窗口（可在托盘菜单或设置中关闭）
- 🔄 **自动更新**：从 GitHub Releases 自动发现新版本，一键静默升级

目前已制作 **macOS** 与 **Windows** 两个版本。

## 快速开始

```bash
npm install
npm start        # 本地运行
```

Windows 打包（产出 NSIS 安装包 `Setup-*.exe`）：

```bash
npm run dist
```

macOS 打包：

```bash
npm run dist:mac
```

> 发布新版本：为仓库打上 `vX.Y.Z` 格式的 tag，并在 GitHub Release 中附上安装包（文件名含 `Setup` 的 `.exe`）资产，桌宠即可在「设置 → 更新」中填写 `owner/repo` 后自动检查更新。

## 素材与动作

- 素材库位于 `character/assets`，动作定义见 `character/actions.json` 与 `character/character.json`。
- 在「动作管理」窗口中可直接导入 GIF、重命名、编辑互动台词，并按模式（安静/日常/办公）组合动作。

## 计划中

项目还在继续完善中，后续会优化：

- Windows 适配
- 动作过渡
- 随机播放
- 素材管理体验

## 声明

※ 本项目为个人制作的**同人桌宠**，非官方作品。
※ 本项目与《明日方舟》及其运营方无关；桌宠角色形象版权归其版权方所有。
※ GIF 表情素材版权归 **@夏雪NazuYuki** 老师所有，请勿将素材用于本项目之外的其他用途。
