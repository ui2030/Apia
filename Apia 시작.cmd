@echo off
setlocal
cd /d "%~dp0"
title Apia

echo ============================================
echo   Apia desktop assistant - launcher
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo  - Install LTS from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not in PATH.
  echo  - Reinstall Node.js LTS, which bundles npm.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run detected. Installing dependencies. This can take a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check the log above.
    pause
    exit /b 1
  )
  echo.
)

echo Preparing Apia (building the latest UI)...
echo.
call npm run build
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. Check the log above.
  pause
  exit /b 1
)

echo.
echo Starting Apia... Close this window or press Ctrl+C to quit.
echo  (Wallpaper mode has no app window - the character lives on your
echo   desktop behind the icons. Use the system tray icon to interact.)
echo.
call npm start

echo.
echo Apia stopped.
pause
endlocal