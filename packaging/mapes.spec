# -*- mode: python ; coding: utf-8 -*-
# Build with:  pyinstaller packaging/mapes.spec
# Produces a single-file MAPES.exe in dist/

block_cipher = None

a = Analysis(
    ['../mapes.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('../mapes/templates', 'mapes/templates'),
        ('../mapes/static', 'mapes/static'),
    ],
    hiddenimports=[
        'webview.platforms.winforms',
        'webview.platforms.edgechromium',
        'tkinter',
        'tkinter.filedialog',
        'tkinter.messagebox',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='MAPES',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
