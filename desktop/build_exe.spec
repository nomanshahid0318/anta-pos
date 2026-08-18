# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for ANTA Shoes POS desktop EXE
# Run from project root:
#   pyinstaller desktop/build_exe.spec

import sys
from pathlib import Path

block_cipher = None
root = Path(SPECPATH).resolve().parent  # anta_pos/

a = Analysis(
    [str(root / 'desktop' / 'main.py')],
    pathex=[str(root / 'backend'), str(root)],
    binaries=[],
    datas=[
        (str(root / 'frontend'), 'frontend'),
        (str(root / 'backend' / 'app'), 'app'),
    ],
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'sqlalchemy.dialects.sqlite',
        'app',
        'app.main',
        'app.database',
        'app.models',
        'app.auth',
        'app.seed',
        'app.routers',
        'app.routers.auth_routes',
        'app.routers.catalog',
        'app.routers.sales',
        'app.routers.inventory_routes',
        'app.routers.reports',
        'app.services.inventory',
        'multipart',
        'jose',
        'passlib.handlers.bcrypt',
    ],
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
    name='ANTA_POS',
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
