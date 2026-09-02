"""Data layer: SQLite with the standard library."""

import os
import sqlite3
import threading
import time

_LOCAL = threading.local()
_DB_PATH = None
_CAPTURES_DIR = None
_PROJECTS_DIR = None
_RESERVED_NAMES = {
    "con", "prn", "aux", "nul", "captures", "exports",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
}
_INIT_LOCK = threading.Lock()
_INITIALISED = False
_JOURNAL_MODE = None


class DatabaseCorrupt(Exception):
    """The database exists but SQLite cannot read it."""

    def __init__(self, path, cause):
        self.path = path
        self.cause = cause
        Exception.__init__(self, str(cause))


class DatabaseUnusable(Exception):
    """The file is healthy but the filesystem will not let us work with it."""

    def __init__(self, path, cause):
        self.path = path
        self.cause = cause
        Exception.__init__(self, str(cause))

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    scope       TEXT DEFAULT '',
    folder      TEXT DEFAULT '',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS hosts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    address     TEXT NOT NULL,
    hostname    TEXT DEFAULT '',
    os          TEXT DEFAULT '',
    label       TEXT DEFAULT '',
    status      TEXT DEFAULT 'todo',
    notes       TEXT DEFAULT '',
    created_at  REAL NOT NULL,
    UNIQUE(project_id, address)
);

CREATE TABLE IF NOT EXISTS services (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id     INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    port        INTEGER NOT NULL,
    proto       TEXT DEFAULT 'tcp',
    name        TEXT DEFAULT '',
    product     TEXT DEFAULT '',
    version     TEXT DEFAULT '',
    state       TEXT DEFAULT 'open',
    notes       TEXT DEFAULT '',
    UNIQUE(host_id, port, proto)
);

CREATE TABLE IF NOT EXISTS outputs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    host_id     INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    tool        TEXT DEFAULT '',
    body        TEXT DEFAULT '',
    pinned      INTEGER DEFAULT 0,
    x           REAL,
    y           REAL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS board (
    project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    drawing     TEXT DEFAULT '[]',
    updated_at  REAL
);

CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT DEFAULT '',
    color       TEXT DEFAULT '',
    x           REAL, y REAL, w REAL, h REAL,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type        TEXT NOT NULL DEFAULT 'generic',
    name        TEXT DEFAULT '',
    status      TEXT DEFAULT 'unknown',
    x           REAL,
    y           REAL,
    color       TEXT DEFAULT '',
    props       TEXT DEFAULT '{}',
    group_id    INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type        TEXT DEFAULT '',
    label       TEXT DEFAULT '',
    props       TEXT DEFAULT '{}',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS node_outputs (
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    output_id   INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    PRIMARY KEY (node_id, output_id)
);

CREATE TABLE IF NOT EXISTS captures (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT DEFAULT '',
    filename    TEXT NOT NULL,
    orig_name   TEXT DEFAULT '',
    mime        TEXT DEFAULT 'image/png',
    size        INTEGER DEFAULT 0,
    width       INTEGER,
    height      INTEGER,
    caption     TEXT DEFAULT '',
    tags        TEXT DEFAULT '',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS node_captures (
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    capture_id  INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    PRIMARY KEY (node_id, capture_id)
);

CREATE TABLE IF NOT EXISTS node_services (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    port        INTEGER NOT NULL,
    proto       TEXT DEFAULT 'tcp',
    name        TEXT DEFAULT '',
    product     TEXT DEFAULT '',
    version     TEXT DEFAULT '',
    state       TEXT DEFAULT 'open',
    notes       TEXT DEFAULT '',
    UNIQUE(node_id, port, proto)
);

CREATE TABLE IF NOT EXISTS node_users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    username    TEXT DEFAULT '',
    domain      TEXT DEFAULT '',
    kind        TEXT DEFAULT 'local',
    privilege   TEXT DEFAULT 'user',
    status      TEXT DEFAULT 'found',
    notes       TEXT DEFAULT '',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS node_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    body        TEXT DEFAULT '',
    kind        TEXT DEFAULT 'note',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT DEFAULT 'Informe',
    body        TEXT DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS app_auth (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    username    TEXT NOT NULL DEFAULT 'admin',
    pw_hash     TEXT NOT NULL,
    kdf_salt    BLOB NOT NULL,
    kdf_rounds  INTEGER NOT NULL,
    wrapped_dek TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS creds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    host_id     INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
    node_id     INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    username    TEXT DEFAULT '',
    secret      TEXT DEFAULT '',
    kind        TEXT DEFAULT 'password',
    hash_type   TEXT DEFAULT '',
    service     TEXT DEFAULT '',
    source      TEXT DEFAULT '',
    status      TEXT DEFAULT 'untested',
    notes       TEXT DEFAULT '',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS cred_nodes (
    cred_id     INTEGER NOT NULL REFERENCES creds(id) ON DELETE CASCADE,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    status      TEXT DEFAULT 'valid',
    PRIMARY KEY (cred_id, node_id)
);

CREATE TABLE IF NOT EXISTS findings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    host_id       INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
    node_id       INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    output_id     INTEGER REFERENCES outputs(id) ON DELETE SET NULL,
    code          TEXT DEFAULT '',
    title         TEXT NOT NULL,
    detail        TEXT DEFAULT '',
    description   TEXT DEFAULT '',
    impact        TEXT DEFAULT '',
    likelihood    TEXT DEFAULT '',
    poc           TEXT DEFAULT '',
    remediation   TEXT DEFAULT '',
    refs          TEXT DEFAULT '',
    cvss_version  TEXT DEFAULT '',
    cvss_vector   TEXT DEFAULT '',
    cvss_score    REAL,
    severity      TEXT DEFAULT 'info',
    status        TEXT DEFAULT 'open',
    retest_at     REAL,
    created_at    REAL NOT NULL,
    updated_at    REAL
);

CREATE TABLE IF NOT EXISTS finding_assets (
    finding_id  INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (finding_id, node_id)
);

CREATE TABLE IF NOT EXISTS finding_captures (
    finding_id  INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    capture_id  INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    PRIMARY KEY (finding_id, capture_id)
);
"""


def configure(db_path):
    global _DB_PATH, _CAPTURES_DIR, _PROJECTS_DIR, _JOURNAL_MODE
    _DB_PATH = db_path
    data_dir = os.path.dirname(db_path)
    os.makedirs(data_dir, exist_ok=True)
    _CAPTURES_DIR = os.path.join(data_dir, "captures")
    _PROJECTS_DIR = os.path.join(data_dir, "projects")
    os.makedirs(_PROJECTS_DIR, exist_ok=True)
    _JOURNAL_MODE = _choose_journal_mode(db_path)


def legacy_captures_dir():
    """The flat data/captures/ folder used before files were split per project."""
    return _CAPTURES_DIR


def projects_dir():
    """Folder holding one subfolder per project."""
    return _PROJECTS_DIR


def folder_slug(name, limit=48):
    """A filesystem-safe folder name derived from a project name."""
    out = "".join(ch if (ch.isalnum() or ch in "-_") else "-" for ch in (name or ""))
    while "--" in out:
        out = out.replace("--", "-")
    out = out.strip("-.").lower()[:limit].strip("-.")
    if out in _RESERVED_NAMES:
        out += "-project"
    return out


def _unique_folder(pid, name):
    base = folder_slug(name) or ("project-%d" % pid)
    taken = {r["folder"] for r in
             rows("SELECT folder FROM projects WHERE id<>? AND folder<>''", (pid,))}
    candidate, n = base, 1
    while candidate in taken:
        n += 1
        candidate = "%s-%d" % (base, n)
    return candidate


def project_folder(pid):
    """The folder name for a project, assigning one the first time it is needed."""
    p = row("SELECT id, name, folder FROM projects WHERE id=?", (pid,))
    if not p:
        raise ValueError("project %r does not exist" % (pid,))
    if p["folder"]:
        return p["folder"]
    folder = _unique_folder(pid, p["name"])
    execute("UPDATE projects SET folder=? WHERE id=?", (folder, pid))
    return folder


def project_dir(pid, create=True):
    """Absolute path of data/projects/<folder>/ for this project."""
    path = os.path.join(_PROJECTS_DIR, project_folder(pid))
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def captures_dir_for(pid, create=True):
    """Where this project's vault images live."""
    path = os.path.join(project_dir(pid, create), "captures")
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def exports_dir_for(pid, create=True):
    """Where this project's generated reports and board images are archived."""
    path = os.path.join(project_dir(pid, create), "exports")
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def rename_project_folder(pid, new_name):
    """Track a project rename on disk. Returns the folder name in use."""
    p = row("SELECT id, name, folder FROM projects WHERE id=?", (pid,))
    if not p:
        return ""
    current = p["folder"] or project_folder(pid)
    wanted = folder_slug(new_name)
    if not wanted or wanted == current:
        return current
    target = _unique_folder(pid, new_name)
    src = os.path.join(_PROJECTS_DIR, current)
    dst = os.path.join(_PROJECTS_DIR, target)
    if os.path.exists(dst):
        return current
    try:
        if os.path.isdir(src):
            os.rename(src, dst)
    except OSError:
        return current
    execute("UPDATE projects SET folder=? WHERE id=?", (target, pid))
    return target


def migrate_capture_files():
    """Move flat data/captures/ files into their project's folder."""
    moved, missing, orphans = 0, 0, []
    old = _CAPTURES_DIR
    if not os.path.isdir(old):
        return moved, missing, orphans

    referenced = set()
    for c in rows("SELECT id, project_id, filename FROM captures WHERE filename<>''"):
        name = os.path.basename(c["filename"])
        referenced.add(name)
        src = os.path.join(old, name)
        dst = os.path.join(captures_dir_for(c["project_id"]), name)
        if os.path.isfile(dst):
            continue
        if not os.path.isfile(src):
            missing += 1
            continue
        try:
            os.replace(src, dst)
            moved += 1
        except OSError:
            missing += 1

    for entry in sorted(os.listdir(old)):
        if os.path.isfile(os.path.join(old, entry)) and entry not in referenced:
            orphans.append(entry)
    if not os.listdir(old):
        try:
            os.rmdir(old)
        except OSError:
            pass
    return moved, missing, orphans


def _wal_works(c):
    """Check that WAL mode ACTUALLY works on this filesystem."""
    try:
        c.execute("SELECT count(*) FROM sqlite_master").fetchone()
        c.execute("BEGIN IMMEDIATE")
        c.execute("ROLLBACK")
        return True
    except sqlite3.OperationalError:
        return False


def _choose_journal_mode(path):
    """Decide once which journal mode this filesystem can sustain."""
    try:
        c = sqlite3.connect(path, timeout=30)
    except sqlite3.OperationalError as e:
        raise DatabaseUnusable(path, e)
    try:
        try:
            mode = (c.execute("PRAGMA journal_mode = WAL").fetchone() or [""])[0]
        except sqlite3.OperationalError:
            mode = ""
        if str(mode).lower() == "wal" and _wal_works(c):
            return "wal"
    except sqlite3.DatabaseError as e:
        c.close()
        if "malformed" in str(e) or "not a database" in str(e):
            raise DatabaseCorrupt(path, e)
        raise DatabaseUnusable(path, e)
    finally:
        try:
            c.close()
        except sqlite3.Error:
            pass

    c = sqlite3.connect(path, timeout=30)
    try:
        c.execute("PRAGMA locking_mode = EXCLUSIVE")
        c.execute("PRAGMA journal_mode = DELETE")
        c.commit()
    except sqlite3.DatabaseError as e:
        c.close()
        raise DatabaseUnusable(path, e)
    finally:
        try:
            c.close()
        except sqlite3.Error:
            pass

    c = sqlite3.connect(path, timeout=30)
    try:
        if not _wal_works(c):
            raise DatabaseUnusable(path, sqlite3.OperationalError("disk I/O error"))
    finally:
        try:
            c.close()
        except sqlite3.Error:
            pass
    return "delete"


def conn():
    """The current thread's own SQLite connection."""
    c = getattr(_LOCAL, "conn", None)
    if c is None:
        c = sqlite3.connect(_DB_PATH, timeout=30, check_same_thread=False)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA foreign_keys = ON")
            c.execute("PRAGMA busy_timeout = 30000")
            c.execute("PRAGMA journal_mode = %s" % (_JOURNAL_MODE or "delete"))
        except sqlite3.OperationalError as e:
            c.close()
            raise DatabaseUnusable(_DB_PATH, e)
        except sqlite3.DatabaseError as e:
            c.close()
            raise DatabaseCorrupt(_DB_PATH, e)
        _LOCAL.conn = c
    return c


def _add_column(c, table, col, decl):
    cols = {r[1] for r in c.execute("PRAGMA table_info(%s)" % table).fetchall()}
    if col not in cols:
        c.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, col, decl))


def _migrate(c):
    """Add new columns to databases created by earlier versions."""
    _add_column(c, "projects", "folder", "TEXT DEFAULT ''")
    for col in ("x", "y"):
        _add_column(c, "outputs", col, "REAL")
    _add_column(c, "creds", "node_id", "INTEGER REFERENCES nodes(id) ON DELETE SET NULL")
    _add_column(c, "creds", "hash_type", "TEXT DEFAULT ''")
    _add_column(c, "findings", "node_id", "INTEGER REFERENCES nodes(id) ON DELETE SET NULL")
    for col, decl in (
        ("code", "TEXT DEFAULT ''"), ("description", "TEXT DEFAULT ''"),
        ("impact", "TEXT DEFAULT ''"), ("likelihood", "TEXT DEFAULT ''"),
        ("poc", "TEXT DEFAULT ''"), ("remediation", "TEXT DEFAULT ''"),
        ("refs", "TEXT DEFAULT ''"), ("cvss_version", "TEXT DEFAULT ''"),
        ("cvss_vector", "TEXT DEFAULT ''"), ("cvss_score", "REAL"),
        ("retest_at", "REAL"), ("updated_at", "REAL")):
        _add_column(c, "findings", col, decl)
    c.commit()
    c.execute("UPDATE findings SET description=detail "
              "WHERE (description='' OR description IS NULL) AND detail<>''")
    c.execute("INSERT OR IGNORE INTO finding_assets (finding_id, node_id) "
              "SELECT id, node_id FROM findings WHERE node_id IS NOT NULL")
    c.execute("UPDATE findings SET status='open' WHERE status IN ('todo','doing')")
    c.execute("UPDATE findings SET status='remediated' WHERE status='done'")
    c.commit()


def init():
    global _INITIALISED
    with _INIT_LOCK:
        if _INITIALISED:
            return
        c = conn()
        try:
            c.executescript(SCHEMA)
            c.commit()
            _migrate(c)
        except sqlite3.DatabaseError as e:
            if "malformed" in str(e) or "not a database" in str(e):
                raise DatabaseCorrupt(_DB_PATH, e)
            raise
        n = c.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        if n == 0:
            c.execute(
                "INSERT INTO projects (name, scope, created_at) VALUES (?,?,?)",
                ("Audit", "", time.time()),
            )
            c.commit()
        _INITIALISED = True


def rows(sql, params=()):
    return [dict(r) for r in conn().execute(sql, params).fetchall()]


def row(sql, params=()):
    r = conn().execute(sql, params).fetchone()
    return dict(r) if r else None


def execute(sql, params=()):
    c = conn()
    cur = c.execute(sql, params)
    c.commit()
    return cur.lastrowid
