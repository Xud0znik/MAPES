#!/usr/bin/env python3
"""MAPES - локальная карта для хранения чего угодно.

Запуск из исходников:  python mapes.py
Или готовый MAPES.exe - двойной клик.

При первом запуске приложение спрашивает, в какой папке хранить данные;
внутри неё создаётся подпапка "data" с файлом mapes.db (так же, как раньше,
когда путь не спрашивался и всегда использовалась app_dir()/data). Выбор
запоминается в mapes_config.json рядом с приложением. Открыть другую (уже
существующую) базу можно позже прямо в интерфейсе, в разделе "База данных".

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
from mapes.config import load_config, save_config
from mapes.paths import app_dir

HOST = "127.0.0.1"
PORT = 5057


def pick_data_dir_dialog():
    """Ask the user, via a native folder-picker, where to store data. A
    "data" subfolder is created inside whatever they pick, so the chosen
    location doesn't get littered with loose mapes.db/mapes_config.json
    files (matches the old, no-prompt default of app_dir()/data). Falls
    back to app_dir()/data if no display/toolkit is available or the
    dialog is cancelled."""
    default = app_dir() / "data"
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        messagebox.showinfo(
            "MAPES",
            "Выбери папку, где MAPES будет хранить свои данные.\n"
            "Внутри неё появится подпапка \"data\" с файлом mapes.db.\n\n"
            "Отмена - будет использована папка \"data\" рядом с приложением.",
        )
        chosen = filedialog.askdirectory(
            title="Папка для данных MAPES", initialdir=str(app_dir())
        )
        root.destroy()
        if chosen:
            return Path(chosen) / "data"
    except Exception:
        pass
    return default


def resolve_data_dir():
    env_path = os.environ.get("MAPES_DATA_DIR")
    if env_path:
        return Path(env_path).expanduser()

    cfg = load_config()
    saved = cfg.get("data_path") or cfg.get("data_dir")
    if saved:
        return Path(saved)

    chosen = pick_data_dir_dialog()
    save_config({**cfg, "data_path": str(chosen)})
    return chosen


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
    """Bridged to the frontend as window.pywebview.api.* so the "Обзор..."
    buttons in the "База данных" section can open native pick dialogs."""

    def pick_folder(self):
        return self._dialog("folder")

    def pick_file(self):
        return self._dialog("file")

    @staticmethod
    def _dialog(kind):
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            if kind == "folder":
                chosen = filedialog.askdirectory(title="Папка с базой данных MAPES")
            else:
                chosen = filedialog.askopenfilename(
                    title="Файл базы данных MAPES (.db)",
                    filetypes=[("SQLite database", "*.db"), ("Все файлы", "*.*")],
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
