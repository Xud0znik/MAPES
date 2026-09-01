#!/usr/bin/env python3
"""MAPES — локальная карта для хранения чего угодно.

Запуск:  python mapes.py
Данные сохраняются в data/mapes.db (SQLite), рядом с этим файлом.
"""
import threading
import webbrowser

from mapes.app import create_app

HOST = "127.0.0.1"
PORT = 5057


def open_browser():
    webbrowser.open(f"http://{HOST}:{PORT}/")


if __name__ == "__main__":
    app = create_app()
    threading.Timer(1.0, open_browser).start()
    print(f"MAPES запущен: http://{HOST}:{PORT}  (Ctrl+C для остановки)")
    app.run(host=HOST, port=PORT, debug=False)
