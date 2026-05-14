@echo off
setlocal
set "ACTION=%~1"
set "SCRIPT_DIR=%~dp0"

if /I "%ACTION%"=="status" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%compact.ps1" -Mode Status
    exit /b %ERRORLEVEL%
)

if /I "%ACTION%"=="compact" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
        "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%SCRIPT_DIR%compact.ps1','-Mode','Compact'"
    exit /b %ERRORLEVEL%
)

echo Usage: dsm-host.cmd ^<status^|compact^>
exit /b 2
