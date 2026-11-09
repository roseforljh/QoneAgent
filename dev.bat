@echo off
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
cd /d "%~dp0"
bun.exe run dev
pause
