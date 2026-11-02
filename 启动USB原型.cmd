@echo off
cd /d "%~dp0"
node scripts/start-usb-prototype.mjs
if errorlevel 1 pause
