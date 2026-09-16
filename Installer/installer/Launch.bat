@echo off
title Google Photos Quota Reclaim
cd /d "%~dp0source"
"%~dp0node\node.exe" server.mjs
if errorlevel 1 (
  echo.
  echo Server exited with an error. See above.
  pause
)
