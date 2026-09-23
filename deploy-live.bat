@echo off
title Pripyat Engine - Live Deploy Restart (no build)
rem FINDINGS #80-A: the work seat has no working npm, so deploys here are
rem LIVE dist patches (compiled JS edited in place, mirrored from src which
rem remains canon). This script only restarts Claude Desktop so the server
rem reloads the patched dist. It never builds; if src and dist have drifted,
rem the next real rebuild (home seat, rebuild.bat) reconciles from src.
cd /d "%~dp0"
echo ============================================
echo  ESCAPE FROM PRIPYAT - live-deploy restart
echo  Tree: %~dp0
echo  (no build - dist is served as patched)
echo ============================================
echo.
echo Stopping Claude Desktop...
taskkill /F /IM Claude.exe >nul 2>&1
echo.
echo ============================================
echo  Done. Relaunch Claude Desktop now.
echo  The server loads dist\ exactly as it sits.
echo ============================================
echo.
pause
