"""Paths helper that works both when run from source and when frozen
into a single .exe by PyInstaller.
"""
import sys
from pathlib import Path


def resource_root() -> Path:
    """Directory that holds templates/ and static/ (read-only, bundled)."""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass) / "mapes"
    return Path(__file__).resolve().parent


def app_dir() -> Path:
    """Directory next to the app (source checkout or the .exe) — used for
    writable data such as the SQLite database."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent
