@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Necesitas instalar Node.js 20 o superior: https://nodejs.org/
  pause
  exit /b 1
)

set "CONFIG=%~1"
if not defined CONFIG if exist ".postula-agent\postula-agent-config.json" set "CONFIG=.postula-agent\postula-agent-config.json"
if not defined CONFIG set /p "CONFIG=Pegá la ruta del postula-agent-config.json descargado: "
set "CONFIG=%CONFIG:"=%"
if not exist "%CONFIG%" (
  echo No encuentro el archivo de configuracion: %CONFIG%
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  call npm install
  if errorlevel 1 goto error
)

call npx playwright install chromium
if errorlevel 1 goto error
call npm run agent -- "%CONFIG%"
set "AGENT_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %AGENT_EXIT%

:error
echo No se pudo preparar el agente. Revisa la conexion y vuelve a intentarlo.
pause
exit /b 1
