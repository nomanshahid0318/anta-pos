# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for ANTA Shoes POS — synced desktop client (thin client, no local backend)
# Run from project root:
#   pyinstaller desktop/build_client_exe.spec

from pathlib import Path

block_cipher = None
root = Path(SPECPATH).resolve().parent  # anta_pos/

a = Analysis(
    [str(root / 'desktop' / 'pos_client.py')],
    pathex=[str(root)],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='ANTA_POS_Store',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # windowed app
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
