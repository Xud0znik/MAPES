# -*- mode: python ; coding: utf-8 -*-
# Build with:  pyinstaller packaging/mapes.spec
# Produces a single-file MAPES(.exe) in dist/ - works for Windows, Linux, macOS,
# whatever platform you run PyInstaller on.

import sys

block_cipher = None

# Only pull in the platform's own pywebview backend as a hidden import - on
# Linux this needs GTK/WebKit system libraries that the build machine may
# not have, so we deliberately do NOT hard-require webview.platforms.gtk
# there. If GTK/WebKit are missing at runtime, mapes.py already falls back
# to opening a regular browser tab instead of crashing.
platform_hidden = []
if sys.platform.startswith("win"):
    platform_hidden = ["webview.platforms.winforms", "webview.platforms.edgechromium"]
elif sys.platform == "darwin":
    platform_hidden = ["webview.platforms.cocoa"]

a = Analysis(
    ['../mapes.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('../mapes/templates', 'mapes/templates'),
        ('../mapes/static', 'mapes/static'),
    ],
    hiddenimports=[
        *platform_hidden,
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
    icon='icon.ico' if sys.platform.startswith("win") else None,
)
