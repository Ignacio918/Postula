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

where powershell.exe >nul 2>nul
if errorlevel 1 goto error
start "Postula · Agente de escritorio" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0agent\PostulaDesktop.ps1" -Config "%CONFIG%"
exit /b 0

:error
echo No se pudo preparar el agente. Revisa la conexion y vuelve a intentarlo.
pause
exit /b 1
