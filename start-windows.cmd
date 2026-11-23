@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0Yingjian-Server.exe" (
  start "" "%~dp0Yingjian-Server.exe"
  exit /b 0
)
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
if not exist "%~dp0node_modules\express\package.json" (
  echo 请先安装 Node.js 22 或更新版本，然后在此目录运行 npm install。
  echo 或使用内置运行环境的 Windows 便携包。
  pause
  exit /b 1
)
echo 映间服务端正在启动（控制台模式）。
echo 浏览器管理入口：http://127.0.0.1:8080/?view=server
echo 关闭此窗口或按 Ctrl+C 将停止服务。
echo 手机和电视需连接同一家庭网络。
"%NODE_EXE%" launcher\host.mjs --console
pause
