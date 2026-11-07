@echo off
setlocal
cd /d "%~dp0" || goto failed
set "app_python=.venv\Scripts\python.exe"
if exist "%app_python%" goto dependencies

set "base_python=py -3"
%base_python% -c "import sys; raise SystemExit(sys.version_info < (3, 10))" >nul 2>&1
if not errorlevel 1 goto create_env
set "base_python=python"
%base_python% -c "import sys; raise SystemExit(sys.version_info < (3, 10))" >nul 2>&1
if not errorlevel 1 goto create_env
echo Python 3.10 or newer is required. Install Python, then run this file again.
goto failed

:create_env
echo Preparing MTG Print Studio for the first run...
%base_python% -m venv .venv
if errorlevel 1 goto failed

:dependencies
"%app_python%" -c "from PIL import Image" >nul 2>&1
if not errorlevel 1 goto run
echo Installing the image processing dependency...
"%app_python%" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto failed

:run
"%app_python%" server.py %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo MTG Print Studio could not start. See the message above.
pause
exit /b 1
