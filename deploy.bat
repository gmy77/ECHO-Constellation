@echo off
rem ECHO Constellation - pubblica la versione online su Cloudflare (pagina + Worker di cache)
cd /d "%~dp0"
wrangler deploy
echo.
echo Pagina online: https://echo-constellation.gimmy077.workers.dev
pause
