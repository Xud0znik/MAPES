#!/usr/bin/env python3
"""MAPES - a local board for storing anything.

Run from source:  python mapes.py
Or the built MAPES.exe - just double-click it.

Doesn't ask anything on startup - as before, it quietly uses the "data"
folder next to the app (or MAPES_DATA_DIR, if set). Opening a different
existing database, or saving a copy of the board somewhere else, can be
done at any time right in the UI (the "File" section in the sidebar).

Opens its own window (pywebview); if pywebview isn't installed, the app
just opens in a browser tab on localhost instead.
"""
import base64
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

from mapes import db
from mapes.app import create_app
from mapes.config import load_config
from mapes.paths import app_dir

HOST = "127.0.0.1"
PORT = 5057


def resolve_data_dir():
    env_path = os.environ.get("MAPES_DATA_DIR")
    if env_path:
        return Path(env_path).expanduser()

    cfg = load_config()
    saved = cfg.get("data_path")
    if saved:
        return Path(saved)

    return app_dir() / "data"


def run_server():
    app = create_app()
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)


def wait_for_server(host, port, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


class Api:
    """Bridged to the frontend as window.pywebview.api.* so the "File"
    section's buttons can open native pick dialogs."""

    def pick_open_file(self):
        """For "Open..." - pick an existing .db file to switch to."""
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.askopenfilename(
                title="Open MAPES database (.db)",
                filetypes=[("SQLite database", "*.db"), ("All files", "*.*")],
            )
            root.destroy()
            return chosen or None
        except Exception:
            return None

    def pick_save_as_file(self):
        """For "Save As..." - pick a destination .db file."""
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.asksaveasfilename(
                title="Save board as...",
                defaultextension=".db",
                filetypes=[("SQLite database", "*.db"), ("All files", "*.*")],
                initialfile="mapes.db",
            )
            root.destroy()
            return chosen or None
        except Exception:
            return None

    def pick_export_json_file(self, default_name):
        """For "Export board to JSON" - pick a destination .json file."""
        return self._pick_export_file(default_name, "mapes-board.json", "JSON", "*.json")

    def pick_export_md_file(self, default_name):
        """For "Export .md" - pick a destination .md file."""
        return self._pick_export_file(default_name, "report.md", "Markdown", "*.md")

    def pick_export_image_file(self, default_name):
        """For "Export board as image" - pick a destination .png file."""
        return self._pick_export_file(default_name, "mapes-board.png", "PNG image", "*.png")

    def pick_backup_zip_file(self, default_name):
        """For "Backup everything as .zip" - pick a destination .zip file."""
        return self._pick_export_file(default_name, "mapes-backup.zip", "ZIP archive", "*.zip")

    def backup_data_zip(self, path):
        """Zip the whole data folder (mapes.db + captures/ + secret.key)
        straight to the given path - unlike the other exports, this needs no
        rendering step in the browser, so it's done directly here instead of
        round-tripping the bytes through the JS bridge as base64."""
        try:
            db.backup_zip_into(Path(path))
            return True
        except Exception as exc:
            return f"error: {exc}"

    def _pick_export_file(self, default_name, fallback_name, filter_label, filter_pattern):
        """Native app windows (pywebview) don't reliably support a plain
        HTML <a download>/<a href> click the way a real browser tab does -
        exporting anything needs this same native-picker + explicit-write
        approach as Save As, instead of a browser-only download trick."""
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            ext = Path(fallback_name).suffix
            chosen = filedialog.asksaveasfilename(
                title=f"Export to {filter_label}",
                defaultextension=ext,
                filetypes=[(filter_label, filter_pattern), ("All files", "*.*")],
                initialfile=default_name or fallback_name,
            )
            root.destroy()
            return chosen or None
        except Exception:
            return None

    def write_text_file(self, path, content):
        """Write UTF-8 text content to an arbitrary path - used together
        with pick_export_json_file()."""
        try:
            Path(path).write_text(content, encoding="utf-8")
            return True
        except Exception as exc:
            return f"error: {exc}"

    def write_binary_file(self, path, base64_data):
        """Write base64-encoded binary content to an arbitrary path - used
        together with pick_export_image_file() for the board PNG export
        (pywebview's JS bridge only carries JSON-safe values, so the PNG
        bytes cross it as a base64 string)."""
        try:
            Path(path).write_bytes(base64.b64decode(base64_data))
            return True
        except Exception as exc:
            return f"error: {exc}"

    def open_external(self, url):
        """Open a URL in the system's actual default browser - a plain
        window.open()/<a target=_blank> inside pywebview's embedded view
        would just navigate (or do nothing) inside the app's own window
        instead, same class of issue as file downloads."""
        try:
            webbrowser.open(url, new=2)
            return True
        except Exception as exc:
            return f"error: {exc}"

    def open_path(self, path):
        """Open a local file or folder with whatever the OS's default
        handler for it is (Explorer/Finder/xdg-open) - there's no way to
        do this from a browser tab at all (for good reason - a webpage
        launching arbitrary local files would be a huge security hole),
        so this only works in the desktop app, never the browser fallback."""
        try:
            p = Path(path).expanduser()
            if not p.exists():
                return f"error: path does not exist: {p}"
            if sys.platform.startswith("win"):
                os.startfile(str(p))  # noqa: S606 - user's own explicit action
            elif sys.platform == "darwin":
                subprocess.run(["open", str(p)], check=False)
            else:
                subprocess.run(["xdg-open", str(p)], check=False)
            return True
        except Exception as exc:
            return f"error: {exc}"


def main():
    data_dir = resolve_data_dir()
    db.configure(data_dir)
    print(f"MAPES: data stored in {db.DB_PATH}")

    threading.Thread(target=run_server, daemon=True).start()
    url = f"http://{HOST}:{PORT}/"
    wait_for_server(HOST, PORT)

    if not open_app_window(url):
        webbrowser.open(url)
        print(f"MAPES running: {url}  (Ctrl+C to stop)")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


def open_app_window(url):
    """Try to open a native app window via pywebview. Returns False (instead
    of crashing) if pywebview isn't installed or has no usable GUI backend
    (e.g. Linux without GTK/Qt) - the caller then falls back to a browser tab."""
    try:
        import webview
    except ImportError:
        return False
    try:
        webview.create_window(
            "MAPES", url, js_api=Api(), width=1280, height=800, min_size=(960, 640)
        )
        webview.start()
        return True
    except Exception as exc:
        print(f"Could not open the app window (pywebview): {exc}")
        return False


if __name__ == "__main__":
    main()
