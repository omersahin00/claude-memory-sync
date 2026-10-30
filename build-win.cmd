@echo off
rem Builds the Windows installer and the portable app into the release folder: double-click this file.
rem Only Node.js 22.12 or newer is needed; npm puts the build tools in node_modules, nothing is installed on the system.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Node.js 22.12 or newer is needed: https://nodejs.org
  pause
  exit /b 1
)
node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 22.12 or newer is needed. This computer has:
  node -v
  pause
  exit /b 1
)

rem One block from here on: cmd reads a whole block before running it, so a pull that changes this file is harmless.
(
  if exist ".git" (
    where git >nul 2>nul && (
      echo Getting the latest code...
      git pull --ff-only || echo Could not get the latest code, building the current one.
    )
  )
  echo Installing the build tools...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Installing failed.
    pause
    exit /b 1
  )
  echo Building...
  call npm run dist:win
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
  echo Done. The installer and the portable app are in the release folder.
  start "" "%~dp0release"
  exit /b 0
)
