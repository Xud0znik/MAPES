#!/usr/bin/env python3
"""MAPES — локальная карта для хранения чего угодно.

Запуск из исходников:  python mapes.py
Или готовый MAPES.exe — двойной клик.

Данные сохраняются в data/mapes.db (SQLite) рядом с приложением.
Открывается отдельное окно (pywebview); если pywebview не установлен —
приложение просто откроется в браузере на localhost.
"""
import socket
import threading
import time
import webbrowser

from mapes.app import create_app

HOST = "127.0.0.1"
PORT = 5057


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
    threading.Thread(target=run_server, daemon=True).start()
    url = f"http://{HOST}:{PORT}/"
    wait_for_server(HOST, PORT)

    try:
        import webview
    except ImportError:
        webbrowser.open(url)
        print(f"MAPES запущен: {url}  (Ctrl+C для остановки)")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        return

    webview.create_window("MAPES", url, width=1280, height=800, min_size=(960, 640))
    webview.start()


if __name__ == "__main__":
    main()
