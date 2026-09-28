@echo off
title AN Mobility Group — Build .exe
color 0A

echo.
echo  =====================================================
echo   AN Mobility Group - Compilando .exe...
echo  =====================================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python no encontrado.
    echo  Instala Python 3.11+ desde https://python.org
    pause
    exit /b 1
)

echo  [1/3] Instalando dependencias...
pip install -r requirements.txt pyinstaller --quiet
if errorlevel 1 (
    echo  [ERROR] Fallo al instalar dependencias.
    pause
    exit /b 1
)

echo  [2/3] Compilando con PyInstaller...
pyinstaller launcher.spec --clean --noconfirm
if errorlevel 1 (
    echo  [ERROR] Fallo en la compilacion.
    pause
    exit /b 1
)

echo  [3/3] Listo!
echo.
echo  =====================================================
echo   El .exe esta en:  dist\ANMobilityAgent.exe
echo  =====================================================
echo.
echo  Puedes distribuir ese archivo directamente.
echo  El usuario solo necesita hacer doble clic.
echo.
pause
