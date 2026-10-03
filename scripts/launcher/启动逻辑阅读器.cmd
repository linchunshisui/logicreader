@echo off
rem LogicReader launcher - double-click this if LogicReader.exe does not open.
rem It retries with safe fallbacks (no admin needed). Log: launcher.log
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0LogicReader-Launcher.ps1" %*
