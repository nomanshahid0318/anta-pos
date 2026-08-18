@echo off
REM Build ANTA_POS_Store.exe (thin client that syncs to your live server)
cd /d "%~dp0\.."

echo Installing dependencies...
python -m pip install -r desktop\requirements-desktop.txt

echo Building EXE with PyInstaller...
python -m PyInstaller desktop\build_client_exe.spec --noconfirm --clean

echo.
echo Done. Output: dist\ANTA_POS_Store.exe
echo.
echo Copy dist\ANTA_POS_Store.exe to each store PC.
echo Optionally place a config.txt next to it containing your server URL, e.g.:
echo   https://anta-pos-29w8.onrender.com/pos/
pause
