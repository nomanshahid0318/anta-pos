@echo off
REM Build ANTA_POS.exe on Windows
cd /d "%~dp0\.."

echo Installing dependencies...
python -m pip install -r backend\requirements.txt
python -m pip install -r desktop\requirements-desktop.txt

echo Building EXE with PyInstaller...
python -m PyInstaller desktop\build_exe.spec --noconfirm --clean

echo.
echo Done. Output: dist\ANTA_POS.exe
echo The EXE creates a "data" folder next to itself for the SQLite database.
pause
