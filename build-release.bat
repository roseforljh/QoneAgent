@echo off
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
cd /d "%~dp0"
echo Starting QoneAgent local Release build...
bun.exe run build:release
pause
