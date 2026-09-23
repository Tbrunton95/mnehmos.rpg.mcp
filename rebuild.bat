@echo off
title Pripyat Engine Rebuild
rem FINDINGS #80: portable rebuild — %~dp0 resolves to wherever this script
rem lives, so the SAME file works on the home tree (C:\Users\Tom\...) and the
rem work clone (C:\mnehmos.rpg.mcp) without editing paths. The old version
rem hardcoded the home path; on any other seat the cd failed silently and
rem npm ran in whatever directory the shell happened to be in.
cd /d "%~dp0"
if not exist package.json (
    echo.
    echo  *** No package.json at %~dp0 ***
    echo  This script must live in the repo root. Nothing was built.
    echo.
    pause
    exit /b 1
)
echo ============================================
echo  ESCAPE FROM PRIPYAT - build and restart
echo  Tree: %~dp0
echo ============================================
echo.
echo Building...
call npm run build
if errorlevel 1 (
    echo.
    echo  *** BUILD FAILED - server untouched. ***
    echo  Fix the error above, then run this again.
    echo.
    pause
    exit /b 1
)
echo.
echo Build OK - stopping Claude Desktop...
taskkill /F /IM Claude.exe >nul 2>&1
echo.
echo ============================================
echo  Done. Relaunch Claude Desktop now.
echo  The server can only load what was just built.
echo ============================================
echo.
pause
