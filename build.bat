@echo off
setlocal enabledelayedexpansion

set ROOT=%~dp0
cd /d "%ROOT%"

echo.
echo ========================================
echo  vcoder build
echo ========================================
echo.

:: ── 1. Install dependencies ──────────────────────────────────────────────
echo [1/3] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed
    exit /b 1
)
echo.

:: ── 2. Build server bundle ───────────────────────────────────────────────
echo [2/3] Building server (packages/opencode + server/dist/index.js)...
call npm run build --workspace=server
if %ERRORLEVEL% neq 0 (
    echo ERROR: server build failed
    exit /b 1
)
echo.

:: ── 3. Build extension + stage server into extension/server/ ─────────────
echo [3/3] Building extension (type-check + bundle + stage server)...
call npm run package --workspace=extension
if %ERRORLEVEL% neq 0 (
    echo ERROR: extension build failed
    exit /b 1
)
echo.

echo ========================================
echo  Build complete!
echo   Server : server\dist\index.js
echo   Ext    : extension\dist\extension.js
echo   Staged : extension\server\
echo ========================================
echo.
echo To package .vsix run:
echo   cd extension ^&^& bun run vsix
echo.
