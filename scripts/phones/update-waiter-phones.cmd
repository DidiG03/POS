@echo off
rem Double-click to update every paired OneTap Waiter phone on this Wi-Fi.
rem Arguments are passed through, e.g.  update-waiter-phones.cmd -Pair 192.168.1.23:37123 -Code 123456
rem Windows blocks downloaded .ps1 files by default; this runs it for this one call only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-waiter-phones.ps1" %*
echo.
pause
