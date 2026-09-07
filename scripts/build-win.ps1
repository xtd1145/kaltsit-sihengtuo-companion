# 凯尔希-思衡托桌宠 · Windows 一键打包脚本（NSIS 安装包）
# 用法：在项目根目录执行  powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
Write-Output '==> 安装依赖'
npm install
Write-Output '==> 打包 Windows NSIS Setup'
npm run dist
Write-Output '==> 完成，安装包位于 dist\ 目录'
Get-ChildItem dist -Filter *.exe | Select-Object -ExpandProperty FullName
