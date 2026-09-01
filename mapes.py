#!/usr/bin/env python3
"""MAPES - локальная карта для хранения чего угодно.

Запуск из исходников:  python mapes.py
Или готовый MAPES.exe - двойной клик.

При первом запуске приложение спрашивает, в какой папке хранить данные
(mapes.db), и запоминает выбор в mapes_config.json рядом с приложением.
Открывается отдельное окно (pywebview); если pywebview не установлен -
приложение просто откроется в браузере на localhost.
"""
import json
import os
import socket
import threading
import time
import webbrowser
from pathlib import Path

from mapes import db
from mapes.app import create_app
from mapes.paths import app_dir

HOST = "127.0.0.1"
PORT = 5057
CONFIG_PATH = app_dir() / "mapes_config.json"


def load_config():
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    return {}


def save_config(cfg):
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def pick_data_dir_dialog():
    """Ask the user, via a native folder-picker, where to store data.
    Falls back to app_dir()/data if no display/toolkit is available or the
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
            "Выбери папку, где MAPES будет хранить свои данные (файл mapes.db).\n\n"
            "Отмена - будет использована папка \"data\" рядом с приложением.",
        )
        chosen = filedialog.askdirectory(
            title="Папка для данных MAPES", initialdir=str(app_dir())
        )
        root.destroy()
        if chosen:
            return Path(chosen)
    except Exception:
        pass
    return default


def resolve_data_dir():
    env_dir = os.environ.get("MAPES_DATA_DIR")
    if env_dir:
        p = Path(env_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p

    cfg = load_config()
    saved = cfg.get("data_dir")
    if saved:
        p = Path(saved)
        try:
            p.mkdir(parents=True, exist_ok=True)
            return p
        except OSError:
            pass  # saved path is no longer valid (e.g. removable drive) - ask again

    chosen = pick_data_dir_dialog()
    chosen.mkdir(parents=True, exist_ok=True)
    save_config({**cfg, "data_dir": str(chosen)})
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


def main():
    data_dir = resolve_data_dir()
    db.configure(data_dir)
    print(f"MAPES: данные хранятся в {data_dir}")

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
        webview.create_window("MAPES", url, width=1280, height=800, min_size=(960, 640))
        webview.start()
        return True
    except Exception as exc:
        print(f"Не удалось открыть окно приложения (pywebview): {exc}")
        return False


if __name__ == "__main__":
    main()
