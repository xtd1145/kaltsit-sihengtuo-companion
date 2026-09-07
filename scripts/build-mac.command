#!/bin/bash
# 凯尔希-思衡托桌宠 · macOS 一键打包脚本
# 用法：双击运行（或在终端执行），产物在 dist/ 目录：dmg / zip
set -e
cd "$(dirname "$0")/.."
echo "==> 安装依赖"
npm install
echo "==> 打包 macOS (dmg + zip)"
npm run dist:mac
echo "==> 完成，打开输出目录"
open dist
