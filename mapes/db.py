import sqlite3
from pathlib import Path

from .paths import app_dir

DATA_DIR = app_dir() / "data"
DB_PATH = DATA_DIR / "mapes.db"


def configure(data_dir):
    """Point the database at a different folder (chosen by the user at
    startup). Must be called before init_db()/get_connection()."""
    global DATA_DIR, DB_PATH
    DATA_DIR = Path(data_dir)
    DB_PATH = DATA_DIR / "mapes.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    type TEXT DEFAULT 'note',
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    color TEXT DEFAULT '#4f8cff',
    x REAL DEFAULT 0,
    y REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_board ON nodes(board_id);
CREATE INDEX IF NOT EXISTS idx_edges_board ON edges(board_id);
"""


def get_connection():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_connection()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
        row = conn.execute("SELECT COUNT(*) AS c FROM boards").fetchone()
        if row["c"] == 0:
            conn.execute(
                "INSERT INTO boards (name, description) VALUES (?, ?)",
                ("Моя карта", "Первая карта - добавляй сюда что угодно"),
            )
            conn.commit()
    finally:
        conn.close()
