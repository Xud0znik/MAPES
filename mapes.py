#!/usr/bin/env python3
"""MAPES - локальная карта для хранения чего угодно.

Запуск из исходников:  python mapes.py
Или готовый MAPES.exe - двойной клик.

Ничего не спрашивает при запуске - как и раньше, тихо использует папку
"data" рядом с приложением (или MAPES_DATA_DIR, если задана). Открыть
другую существующую базу, или сохранить копию карты в выбранное место,
можно в любой момент прямо в интерфейсе (раздел "Файл" в сайдбаре).

Открывается отдельное окно (pywebview); если pywebview не установлен -
приложение просто откроется в браузере на localhost.
"""
import os
import socket
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
    """Bridged to the frontend as window.pywebview.api.* so the "Файл"
    section's buttons can open native pick dialogs."""

    def pick_open_file(self):
        """For "Открыть..." - pick an existing .db file to switch to."""
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.askopenfilename(
                title="Открыть базу данных MAPES (.db)",
                filetypes=[("SQLite database", "*.db"), ("Все файлы", "*.*")],
            )
            root.destroy()
            return chosen or None
        except Exception:
            return None

    def pick_save_as_file(self):
        """For "Сохранить как..." - pick a destination .db file."""
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.asksaveasfilename(
                title="Сохранить карту как...",
                defaultextension=".db",
                filetypes=[("SQLite database", "*.db"), ("Все файлы", "*.*")],
                initialfile="mapes.db",
            )
            root.destroy()
            return chosen or None
        except Exception:
            return None


def main():
    data_dir = resolve_data_dir()
    db.configure(data_dir)
    print(f"MAPES: данные хранятся в {db.DB_PATH}")

    threading.Thread(target=run_server, daemon=True).start()
    url = f"http://{HOST}:{PORT}/"
    wait_for_server(HOST, PORT)

    if not open_app_window(url):
        webbrowser.open(url)
        print(f"MAPES запущен: {url}  (Ctrl+C для остановки)")
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
        print(f"Не удалось открыть окно приложения (pywebview): {exc}")
        return False


if __name__ == "__main__":
    main()
