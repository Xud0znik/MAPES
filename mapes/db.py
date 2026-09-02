import sqlite3
from pathlib import Path

from .paths import app_dir

DATA_DIR = app_dir() / "data"
DB_PATH = DATA_DIR / "mapes.db"


def configure(path):
    """Point the database at a different location: either a folder (the db
    lives at <folder>/mapes.db, created if missing) or a direct path to an
    existing/new .db file. Must be called before init_db()/get_connection()."""
    global DATA_DIR, DB_PATH
    p = Path(path).expanduser()
    if p.suffix.lower() == ".db":
        DB_PATH = p
        DATA_DIR = p.parent
    else:
        DATA_DIR = p
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

CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    orig_name TEXT DEFAULT '',
    mime TEXT DEFAULT 'image/png',
    size INTEGER DEFAULT 0,
    caption TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS creds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    username TEXT DEFAULT '',
    secret TEXT DEFAULT '',
    kind TEXT DEFAULT 'password',
    hash_type TEXT DEFAULT '',
    service TEXT DEFAULT '',
    status TEXT DEFAULT 'untested',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    impact TEXT DEFAULT '',
    poc TEXT DEFAULT '',
    remediation TEXT DEFAULT '',
    refs TEXT DEFAULT '',
    severity TEXT DEFAULT 'info',
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title TEXT DEFAULT 'Report',
    body TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_board ON nodes(board_id);
CREATE INDEX IF NOT EXISTS idx_edges_board ON edges(board_id);
CREATE INDEX IF NOT EXISTS idx_captures_board ON captures(board_id);
CREATE INDEX IF NOT EXISTS idx_creds_board ON creds(board_id);
CREATE INDEX IF NOT EXISTS idx_findings_board ON findings(board_id);
CREATE INDEX IF NOT EXISTS idx_docs_board ON docs(board_id);
"""


def get_connection():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def captures_dir_for(board_id):
    """Where uploaded vault files for a board live on disk, next to the
    live database (NOT copied by "Save As" - only the .db is)."""
    d = DATA_DIR / "captures" / str(board_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def backup_to(dest_path):
    """Safely copy the current live database to dest_path using SQLite's
    online backup API (consistent even while the app is being used), for
    the "Save As" / "Save" actions."""
    dest = Path(dest_path).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    src_conn = sqlite3.connect(DB_PATH)
    dest_conn = sqlite3.connect(dest)
    try:
        with dest_conn:
            src_conn.backup(dest_conn)
    finally:
        src_conn.close()
        dest_conn.close()


def init_db():
    conn = get_connection()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
        row = conn.execute("SELECT COUNT(*) AS c FROM boards").fetchone()
        if row["c"] == 0:
            conn.execute(
                "INSERT INTO boards (name, description) VALUES (?, ?)",
                ("My board", "Your first board - put anything on it"),
            )
            conn.commit()
    finally:
        conn.close()
