"""HTTP server (standard library) + JSON API."""

import base64
import binascii
import http.cookies
import ipaddress
import json
import os
import re
import ssl
import struct
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import auth, crypto, db, mdown

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

CONFIG = {}
SESSION_COOKIE = "atlas_session"


def cookie_values(raw, name):
    """All values for a cookie name in a Cookie header, in order."""
    out = []
    for part in (raw or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == name and v:
            out.append(v)
    return out

PUBLIC_PATHS = {"/", "/index.html", "/api/login", "/api/session"}
PUBLIC_PREFIXES = ("/static/",)


def host_name(raw):
    """The hostname from a Host header, without the port. '' if missing."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.startswith("["):
        return raw[1:].partition("]")[0].strip().lower()
    if raw.count(":") == 1:
        raw = raw.rsplit(":", 1)[0]
    return raw.strip().lower()


def host_allowed(raw):
    """Anti-DNS-rebinding: accept only IP-literal hosts, localhost, or names"""
    host = host_name(raw)
    if not host:
        return True
    if host == "localhost":
        return True
    if host in {h.strip().lower() for h in CONFIG.get("allowed_hosts", [])}:
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False

MAX_BODY = 48 * 1024 * 1024

_ROUTES = []


class NotFound(KeyError):
    """The requested resource does not exist -> 404."""


class Unauthorized(Exception):
    """Bad credentials or no session -> 401."""


class Throttled(Exception):
    """Too many failed logins from this address -> 429."""


def route(method, pattern):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        _ROUTES.append((method, rx, fn))
        return fn

    return deco


class Raw:
    """Binary response (a vault image), not JSON."""

    def __init__(self, data, ctype, filename=None, download=False, cache=False,
                 saved_to=""):
        self.data = data
        self.ctype = ctype
        self.filename = filename
        self.download = download
        self.cache = cache
        self.saved_to = saved_to


class Req:
    def __init__(self, handler, query, body):
        self.h = handler
        self.query = query
        self.body = body or {}

    def q(self, key, default=None):
        v = self.query.get(key)
        return v[0] if v else default

    def flag(self, key):
        return (self.q(key) or "") not in ("", "0", "false", "no")

    def pid(self):
        return int(self.q("project_id") or _default_project())

    def cookie(self, name):
        vals = cookie_values(self.h.headers.get("Cookie"), name)
        return vals[0] if vals else None

    def session_tokens(self):
        return cookie_values(self.h.headers.get("Cookie"), SESSION_COOKIE)

    def client_ip(self):
        return self.h.client_address[0] if self.h.client_address else "?"


def _default_project():
    r = db.row("SELECT id FROM projects ORDER BY id LIMIT 1")
    return r["id"] if r else 1


def _int_or_none(v):
    if v in ("", None, "null"):
        return None
    return int(v)


def _need_node(v):
    """A node id that is required and must exist (else 404 rather than an FK 500)."""
    nid = _int_or_none(v)
    if not nid:
        raise ValueError("node_id is required")
    if not db.row("SELECT id FROM nodes WHERE id=?", (nid,)):
        raise NotFound("node %d not found" % nid)
    return nid


@route("GET", r"/api/projects")
def list_projects(req, m):
    return db.rows("SELECT * FROM projects ORDER BY id")


@route("POST", r"/api/projects")
def create_project(req, m):
    name = (req.body.get("name") or "Auditoria").strip()
    pid = db.execute(
        "INSERT INTO projects (name, scope, created_at) VALUES (?,?,?)",
        (name, req.body.get("scope", ""), time.time()),
    )
    db.project_dir(pid)
    return db.row("SELECT * FROM projects WHERE id=?", (pid,))


@route("PATCH", r"/api/projects/(\d+)")
def update_project(req, m):
    pid = int(m.group(1))
    _patch("projects", pid, req.body, {"name", "scope"})
    if "name" in req.body:
        db.rename_project_folder(pid, req.body["name"])
    return db.row("SELECT * FROM projects WHERE id=?", (pid,))


@route("GET", r"/api/overview")
def overview(req, m):
    pid = req.pid()
    nodes = [_node_out(n, light=True) for n in db.rows(
        "SELECT * FROM nodes WHERE project_id=? ORDER BY id", (pid,))]
    one = lambda sql, p=(pid,): db.row(sql, p)["c"]
    metrics = {
        "nodes": len(nodes),
        "pwned": len([n for n in nodes if n["status"] == "pwned"]),
        "edges": one("SELECT COUNT(*) c FROM edges WHERE project_id=?"),
        "open_ports": one(
            "SELECT COUNT(*) c FROM node_services s JOIN nodes n ON n.id=s.node_id "
            "WHERE n.project_id=? AND s.state='open'"),
        "users": one("SELECT COUNT(*) c FROM node_users u JOIN nodes n ON n.id=u.node_id "
                     "WHERE n.project_id=?"),
        "creds": one("SELECT COUNT(*) c FROM creds WHERE project_id=?"),
        "captures": one("SELECT COUNT(*) c FROM captures WHERE project_id=?"),
    }
    steps = db.rows(
        "SELECT f.*, (SELECT n.name FROM finding_assets fa JOIN nodes n ON n.id=fa.node_id "
        "WHERE fa.finding_id=f.id ORDER BY n.id LIMIT 1) AS node_name FROM findings f "
        "WHERE f.project_id=? AND f.status NOT IN ('remediated','accepted') ORDER BY "
        "CASE f.severity WHEN 'crit' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 "
        "WHEN 'low' THEN 3 ELSE 4 END, f.id DESC",
        (pid,),
    )
    recent = db.rows(
        "SELECT id, name, filename, mime, width, height, created_at FROM captures "
        "WHERE project_id=? ORDER BY created_at DESC LIMIT 8", (pid,))
    return {"project": db.row("SELECT * FROM projects WHERE id=?", (pid,)),
            "metrics": metrics, "nodes": nodes, "steps": steps, "captures": recent}


@route("GET", r"/api/hosts")
def list_hosts(req, m):
    return db.rows(
        "SELECT h.*, "
        "(SELECT COUNT(*) FROM services s WHERE s.host_id=h.id AND s.state='open') AS open_ports "
        "FROM hosts h WHERE h.project_id=? ORDER BY h.id", (req.pid(),))


@route("POST", r"/api/hosts")
def create_host(req, m):
    pid = int(req.body.get("project_id") or req.pid())
    addr = (req.body.get("address") or "").strip()
    if not addr:
        raise ValueError("address requerido")
    existing = db.row("SELECT * FROM hosts WHERE project_id=? AND address=?", (pid, addr))
    if existing:
        return existing
    hid = db.execute(
        "INSERT INTO hosts (project_id, address, hostname, label, created_at) VALUES (?,?,?,?,?)",
        (pid, addr, req.body.get("hostname", ""), req.body.get("label", ""), time.time()))
    return db.row("SELECT * FROM hosts WHERE id=?", (hid,))


@route("GET", r"/api/hosts/(\d+)")
def get_host(req, m):
    hid = int(m.group(1))
    host = db.row("SELECT * FROM hosts WHERE id=?", (hid,))
    if not host:
        raise NotFound("host no encontrado")
    host["services"] = db.rows("SELECT * FROM services WHERE host_id=? ORDER BY port", (hid,))
    return host


@route("PATCH", r"/api/hosts/(\d+)")
def update_host(req, m):
    hid = int(m.group(1))
    _patch("hosts", hid, req.body, {"hostname", "os", "label", "status", "notes", "address"})
    return db.row("SELECT * FROM hosts WHERE id=?", (hid,))


@route("DELETE", r"/api/hosts/(\d+)")
def delete_host(req, m):
    db.execute("DELETE FROM hosts WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


@route("POST", r"/api/services")
def create_service(req, m):
    b = req.body
    sid = db.execute(
        "INSERT INTO services (host_id, port, proto, name, product, version, state, notes)"
        " VALUES (?,?,?,?,?,?,?,?)"
        " ON CONFLICT(host_id, port, proto) DO UPDATE SET name=excluded.name,"
        " product=excluded.product, version=excluded.version, state=excluded.state",
        (int(b["host_id"]), int(b["port"]), b.get("proto", "tcp"), b.get("name", ""),
         b.get("product", ""), b.get("version", ""), b.get("state", "open"), b.get("notes", "")))
    return db.row("SELECT * FROM services WHERE id=?", (sid,))


@route("DELETE", r"/api/services/(\d+)")
def delete_service(req, m):
    db.execute("DELETE FROM services WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


def _node_out(n, light=False):
    """Deserialise props (JSON) and attach the captures and the counters."""
    if not n:
        return n
    try:
        n["props"] = json.loads(n.get("props") or "{}")
    except (ValueError, TypeError):
        n["props"] = {}
    nid = n["id"]
    count = lambda sql: db.row(sql, (nid,))["c"]
    if light:
        n["captures"] = []
        caps = count("SELECT COUNT(*) c FROM node_captures WHERE node_id=?")
    else:
        n["captures"] = db.rows(
            "SELECT c.id, c.name, c.filename, c.mime, c.width, c.height FROM node_captures nc "
            "JOIN captures c ON c.id=nc.capture_id WHERE nc.node_id=? ORDER BY c.id", (nid,))
        for c in n["captures"]:
            c["url"] = "/api/captures/%d/file" % c["id"]
        caps = len(n["captures"])
    n["counts"] = {
        "captures": caps,
        "services": count("SELECT COUNT(*) c FROM node_services WHERE node_id=?"),
        "users": count("SELECT COUNT(*) c FROM node_users WHERE node_id=?"),
        "creds": count("SELECT COUNT(*) c FROM creds WHERE node_id=?"),
        "findings": count("SELECT COUNT(*) c FROM finding_assets WHERE node_id=?"),
        "notes": count("SELECT COUNT(*) c FROM node_notes WHERE node_id=?"),
    }
    return n


@route("GET", r"/api/nodes")
def list_nodes(req, m):
    pid = req.pid()
    q = (req.q("q") or "").strip()
    sql = "SELECT * FROM nodes WHERE project_id=?"
    params = [pid]
    if q:
        sql += " AND (name LIKE ? OR type LIKE ? OR props LIKE ?)"
        params += ["%" + q + "%"] * 3
    sql += " ORDER BY id"
    return [_node_out(n) for n in db.rows(sql, tuple(params))]


@route("POST", r"/api/nodes")
def create_node(req, m):
    b = req.body
    pid = int(b.get("project_id") or req.pid())
    now = time.time()
    props = b.get("props", {})
    if not isinstance(props, str):
        props = json.dumps(props or {})
    x, y = b.get("x"), b.get("y")
    if x is None or y is None:
        k = db.row("SELECT COUNT(*) c FROM nodes WHERE project_id=?", (pid,))["c"]
        x, y = 60 + (k % 8) * 160, 60 + (k // 8) * 180
    nid = db.execute(
        "INSERT INTO nodes (project_id, type, name, status, x, y, color, props, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (pid, b.get("type", "generic"), b.get("name", ""), b.get("status", "unknown"),
         x, y, b.get("color", ""), props, now, now))
    return _node_out(db.row("SELECT * FROM nodes WHERE id=?", (nid,)))


@route("GET", r"/api/nodes/(\d+)")
def get_node(req, m):
    n = _node_out(db.row("SELECT * FROM nodes WHERE id=?", (int(m.group(1)),)))
    if not n:
        raise NotFound("nodo no encontrado")
    return n


@route("GET", r"/api/nodes/(\d+)/detail")
def node_detail(req, m):
    """Everything about a node in a single call (for the detail view)."""
    nid = int(m.group(1))
    n = _node_out(db.row("SELECT * FROM nodes WHERE id=?", (nid,)))
    if not n:
        raise NotFound("nodo no encontrado")
    n["services"] = db.rows("SELECT * FROM node_services WHERE node_id=? ORDER BY port, proto", (nid,))
    n["users"] = db.rows("SELECT * FROM node_users WHERE node_id=? ORDER BY id DESC", (nid,))
    n["creds"] = _decrypt_creds(db.rows("SELECT * FROM creds WHERE node_id=? ORDER BY id DESC", (nid,)))
    n["findings"] = db.rows(
        "SELECT f.* FROM findings f JOIN finding_assets fa ON fa.finding_id=f.id "
        "WHERE fa.node_id=? ORDER BY CASE f.severity WHEN 'crit' THEN 0 WHEN 'high' THEN 1 "
        "WHEN 'med' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, f.id DESC", (nid,))
    n["log"] = db.rows("SELECT * FROM node_notes WHERE node_id=? ORDER BY created_at DESC", (nid,))
    n["links"] = db.rows(
        "SELECT e.id, e.type, e.label, e.source_id, e.target_id, "
        "s.name AS source_name, s.type AS source_type, s.status AS source_status, "
        "t.name AS target_name, t.type AS target_type, t.status AS target_status "
        "FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id "
        "WHERE e.source_id=? OR e.target_id=? ORDER BY e.id", (nid, nid))
    return n


@route("PATCH", r"/api/nodes/(\d+)")
def update_node(req, m):
    nid = int(m.group(1))
    body = dict(req.body)
    if "props" in body and not isinstance(body["props"], str):
        body["props"] = json.dumps(body["props"] or {})
    if {"type", "name", "status", "color", "props"} & set(body):
        body["updated_at"] = time.time()
    _patch("nodes", nid, body, {"type", "name", "status", "x", "y", "color", "props", "group_id", "updated_at"})
    n = _node_out(db.row("SELECT * FROM nodes WHERE id=?", (nid,)))
    if not n:
        raise NotFound("node not found")
    return n


@route("DELETE", r"/api/nodes/(\d+)")
def delete_node(req, m):
    db.execute("DELETE FROM nodes WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


_PORT_RX = re.compile(r"^\s*(\d{1,5})\s*(?:/\s*(tcp|udp))?\s*[\s:-]*(.*)$", re.I)


@route("POST", r"/api/nodes/(\d+)/migrate_props")
def migrate_node_props(req, m):
    """Convert the free-text lists in props into real records."""
    nid = int(m.group(1))
    n = db.row("SELECT * FROM nodes WHERE id=?", (nid,))
    if not n:
        raise NotFound("nodo no encontrado")
    try:
        props = json.loads(n["props"] or "{}")
    except (ValueError, TypeError):
        props = {}
    now = time.time()
    moved = 0

    def items(key):
        v = props.get(key)
        return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []

    for raw in items("ports"):
        mt = _PORT_RX.match(raw)
        if not mt:
            continue
        port, proto, rest = int(mt.group(1)), (mt.group(2) or "tcp").lower(), mt.group(3).strip()
        bits = rest.split(None, 1)
        db.execute(
            "INSERT OR IGNORE INTO node_services (node_id, port, proto, name, product)"
            " VALUES (?,?,?,?,?)",
            (nid, port, proto, bits[0] if bits else "", bits[1] if len(bits) > 1 else ""))
        moved += 1

    for raw in items("users"):
        dom, _, user = raw.partition("\\")
        if not user:
            user, dom = raw, ""
        db.execute(
            "INSERT INTO node_users (node_id, username, domain, created_at) VALUES (?,?,?,?)",
            (nid, user.strip(), dom.strip(), now))
        moved += 1

    for raw in items("credentials"):
        user, sep, secret = raw.partition(":")
        db.execute(
            "INSERT INTO creds (project_id, node_id, username, secret, source, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (n["project_id"], nid, user.strip(),
             auth.encrypt_secret(secret.strip() if sep else ""), "pizarra", now))
        moved += 1

    for key, prefix in (("services", "servicio: "), ("notes", "")):
        for raw in items(key):
            db.execute("INSERT INTO node_notes (node_id, body, kind, created_at) VALUES (?,?,?,?)",
                       (nid, prefix + raw, "note", now))
            moved += 1

    for key in ("ports", "users", "credentials", "services", "notes"):
        props.pop(key, None)
    db.execute("UPDATE nodes SET props=?, updated_at=? WHERE id=?",
               (json.dumps(props), now, nid))
    out = _node_out(db.row("SELECT * FROM nodes WHERE id=?", (nid,)))
    out["moved"] = moved
    return out


@route("GET", r"/api/node_services")
def list_node_services(req, m):
    return db.rows("SELECT * FROM node_services WHERE node_id=? ORDER BY port, proto",
                   (int(req.q("node_id")),))


@route("POST", r"/api/node_services")
def create_node_service(req, m):
    b = req.body
    nid = _need_node(b.get("node_id"))
    if not b.get("port"):
        raise ValueError("puerto requerido")
    port, proto = int(b["port"]), (b.get("proto") or "tcp")
    db.execute(
        "INSERT INTO node_services (node_id, port, proto, name, product, version, state, notes)"
        " VALUES (?,?,?,?,?,?,?,?)"
        " ON CONFLICT(node_id, port, proto) DO UPDATE SET name=excluded.name,"
        " product=excluded.product, version=excluded.version, state=excluded.state,"
        " notes=excluded.notes",
        (nid, port, proto, b.get("name", ""), b.get("product", ""), b.get("version", ""),
         b.get("state", "open"), b.get("notes", "")))
    return db.row("SELECT * FROM node_services WHERE node_id=? AND port=? AND proto=?",
                  (nid, port, proto))


@route("PATCH", r"/api/node_services/(\d+)")
def update_node_service(req, m):
    sid = int(m.group(1))
    _patch("node_services", sid, req.body,
           {"port", "proto", "name", "product", "version", "state", "notes"})
    return db.row("SELECT * FROM node_services WHERE id=?", (sid,))


@route("DELETE", r"/api/node_services/(\d+)")
def delete_node_service(req, m):
    db.execute("DELETE FROM node_services WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


@route("GET", r"/api/node_users")
def list_node_users(req, m):
    return db.rows("SELECT * FROM node_users WHERE node_id=? ORDER BY id DESC",
                   (int(req.q("node_id")),))


@route("POST", r"/api/node_users")
def create_node_user(req, m):
    b = req.body
    uid = db.execute(
        "INSERT INTO node_users (node_id, username, domain, kind, privilege, status, notes, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (_need_node(b.get("node_id")), (b.get("username") or "").strip(), b.get("domain", ""),
         b.get("kind", "local"), b.get("privilege", "user"), b.get("status", "found"),
         b.get("notes", ""), time.time()))
    return db.row("SELECT * FROM node_users WHERE id=?", (uid,))


@route("PATCH", r"/api/node_users/(\d+)")
def update_node_user(req, m):
    uid = int(m.group(1))
    _patch("node_users", uid, req.body,
           {"username", "domain", "kind", "privilege", "status", "notes"})
    return db.row("SELECT * FROM node_users WHERE id=?", (uid,))


@route("DELETE", r"/api/node_users/(\d+)")
def delete_node_user(req, m):
    db.execute("DELETE FROM node_users WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


@route("GET", r"/api/node_notes")
def list_node_notes(req, m):
    return db.rows("SELECT * FROM node_notes WHERE node_id=? ORDER BY created_at DESC",
                   (int(req.q("node_id")),))


@route("POST", r"/api/node_notes")
def create_node_note(req, m):
    b = req.body
    nid = db.execute(
        "INSERT INTO node_notes (node_id, body, kind, created_at) VALUES (?,?,?,?)",
        (_need_node(b.get("node_id")), b.get("body", ""), b.get("kind", "note"), time.time()))
    return db.row("SELECT * FROM node_notes WHERE id=?", (nid,))


@route("PATCH", r"/api/node_notes/(\d+)")
def update_node_note(req, m):
    nid = int(m.group(1))
    _patch("node_notes", nid, req.body, {"body", "kind"})
    return db.row("SELECT * FROM node_notes WHERE id=?", (nid,))


@route("DELETE", r"/api/node_notes/(\d+)")
def delete_node_note(req, m):
    db.execute("DELETE FROM node_notes WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


_MAGIC = [
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
    (b"GIF87a", "image/gif", ".gif"),
    (b"GIF89a", "image/gif", ".gif"),
    (b"BM", "image/bmp", ".bmp"),
]
_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
        "image/bmp": ".bmp", "image/webp": ".webp"}


def _sniff(data):
    """(mime, ext) from the magic bytes. None if it is not a raster image."""
    for magic, mime, ext in _MAGIC:
        if data.startswith(magic):
            return mime, ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None, None


def _img_size(data):
    """Dimensions with no external dependencies. (None, None) if not derivable."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:3] == b"GIF":
            return struct.unpack("<HH", data[6:10])
        if data[:2] == b"BM":
            w, hh = struct.unpack("<ii", data[18:26])
            return abs(w), abs(hh)
        if data[:2] == b"\xff\xd8":
            i, n = 2, len(data)
            while i < n - 9:
                if data[i] != 0xFF:
                    i += 1
                    continue
                mk = data[i + 1]
                if mk == 0xD8 or mk == 0x01 or 0xD0 <= mk <= 0xD7:
                    i += 2
                    continue
                ln = struct.unpack(">H", data[i + 2:i + 4])[0]
                if 0xC0 <= mk <= 0xCF and mk not in (0xC4, 0xC8, 0xCC):
                    hh, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return w, hh
                i += 2 + ln
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            tag = data[12:16]
            if tag == b"VP8X":
                return (int.from_bytes(data[24:27], "little") + 1,
                        int.from_bytes(data[27:30], "little") + 1)
            if tag == b"VP8 ":
                return (struct.unpack("<H", data[26:28])[0] & 0x3FFF,
                        struct.unpack("<H", data[28:30])[0] & 0x3FFF)
            if tag == b"VP8L":
                b0 = int.from_bytes(data[21:25], "little")
                return (b0 & 0x3FFF) + 1, ((b0 >> 14) & 0x3FFF) + 1
    except Exception:
        pass
    return None, None


def _slug(s, limit=36):
    s = "".join(ch if (ch.isalnum() or ch in "-_") else "-" for ch in (s or ""))
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-").lower()[:limit] or "capture"


def _capture_path(pid, filename):
    """Absolute path inside this project's captures folder, with no escapes (../)."""
    base = db.captures_dir_for(pid)
    full = os.path.normpath(os.path.join(base, os.path.basename(filename or "")))
    if not full.startswith(base):
        raise NotFound("capture outside the vault")
    return full


def _capture_file(c):
    """Where a capture row's image really is: its project folder, or the old"""
    current = _capture_path(c["project_id"], c["filename"])
    if os.path.isfile(current):
        return current
    legacy = os.path.join(db.legacy_captures_dir(), os.path.basename(c["filename"] or ""))
    return legacy if os.path.isfile(legacy) else current


def _remove_capture_files(c):
    """Delete a capture's image from every folder it may live in."""
    name = os.path.basename(c["filename"] or "")
    if not name:
        return []
    left = []
    for path in (_capture_path(c["project_id"], name),
                 os.path.join(db.legacy_captures_dir(), name)):
        if not os.path.isfile(path):
            continue
        try:
            os.remove(path)
        except OSError as e:
            left.append(os.path.basename(path))
            print("atlas: could not delete %s (%s)" % (path, e))
    return left


def _capture_out(c):
    if c:
        c["url"] = "/api/captures/%d/file" % c["id"]
        c["nodes"] = db.rows(
            "SELECT n.id, n.name, n.type, n.status FROM node_captures nc "
            "JOIN nodes n ON n.id=nc.node_id WHERE nc.capture_id=? ORDER BY n.id", (c["id"],))
    return c


@route("GET", r"/api/captures")
def list_captures(req, m):
    pid = req.pid()
    q = (req.q("q") or "").strip()
    node_id = req.q("node_id")
    sql = "SELECT c.* FROM captures c WHERE c.project_id=?"
    params = [pid]
    if node_id == "none":
        sql += " AND NOT EXISTS (SELECT 1 FROM node_captures nc WHERE nc.capture_id=c.id)"
    elif node_id:
        sql += " AND EXISTS (SELECT 1 FROM node_captures nc WHERE nc.capture_id=c.id AND nc.node_id=?)"
        params.append(int(node_id))
    if q:
        sql += " AND (c.name LIKE ? OR c.caption LIKE ? OR c.tags LIKE ? OR c.orig_name LIKE ?)"
        params += ["%" + q + "%"] * 4
    sql += " ORDER BY c.created_at DESC"
    return [_capture_out(c) for c in db.rows(sql, tuple(params))]


@route("POST", r"/api/captures")
def create_capture(req, m):
    """Upload a capture. The body carries the image as base64 (or a data URL)."""
    b = req.body
    pid = int(b.get("project_id") or req.pid())
    raw = b.get("data") or ""
    if isinstance(raw, str) and raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError):
        raise ValueError("invalid image (base64)")
    if not data:
        raise ValueError("empty image")

    mime, ext = _sniff(data)
    if not mime:
        raise ValueError("unsupported format: upload PNG, JPG, GIF, BMP or WEBP")
    width, height = _img_size(data)

    node_id = _int_or_none(b.get("node_id"))
    if node_id and not db.row("SELECT id FROM nodes WHERE id=? AND project_id=?", (node_id, pid)):
        raise ValueError("node %d does not exist in this project" % node_id)

    orig = os.path.basename(b.get("orig_name") or "")[:120]
    name = (b.get("name") or "").strip() or os.path.splitext(orig)[0] or "captura"
    now = time.time()
    cid = db.execute(
        "INSERT INTO captures (project_id, name, filename, orig_name, mime, size,"
        " width, height, caption, tags, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (pid, name, "", orig, mime, len(data), width, height,
         b.get("caption", ""), b.get("tags", ""), now))

    filename = "cap-%05d-%s%s" % (cid, _slug(name), ext)
    try:
        with open(_capture_path(pid, filename), "wb") as f:
            f.write(data)
    except OSError as e:
        db.execute("DELETE FROM captures WHERE id=?", (cid,))
        raise ValueError("no pude guardar la imagen: %s" % e)
    db.execute("UPDATE captures SET filename=? WHERE id=?", (filename, cid))

    if node_id:
        db.execute("INSERT OR IGNORE INTO node_captures (node_id, capture_id) VALUES (?,?)",
                   (node_id, cid))
    return _capture_out(db.row("SELECT * FROM captures WHERE id=?", (cid,)))


@route("GET", r"/api/captures/(\d+)")
def get_capture(req, m):
    c = _capture_out(db.row("SELECT * FROM captures WHERE id=?", (int(m.group(1)),)))
    if not c:
        raise NotFound("captura no encontrada")
    return c


@route("GET", r"/api/captures/(\d+)/file")
def get_capture_file(req, m):
    c = db.row("SELECT * FROM captures WHERE id=?", (int(m.group(1)),))
    if not c or not c["filename"]:
        raise NotFound("captura no encontrada")
    path = _capture_file(c)
    if not os.path.isfile(path):
        raise NotFound("the capture file is missing from the project folder")
    with open(path, "rb") as f:
        data = f.read()
    dl_name = (c["orig_name"] or c["filename"])
    return Raw(data, c["mime"] or "application/octet-stream",
               filename=dl_name, download=req.flag("download"), cache=True)


@route("PATCH", r"/api/captures/(\d+)")
def update_capture(req, m):
    cid = int(m.group(1))
    _patch("captures", cid, req.body, {"name", "caption", "tags"})
    return _capture_out(db.row("SELECT * FROM captures WHERE id=?", (cid,)))


@route("DELETE", r"/api/captures/(\d+)")
def delete_capture(req, m):
    cid = int(m.group(1))
    c = db.row("SELECT * FROM captures WHERE id=?", (cid,))
    if not c:
        raise NotFound("captura no encontrada")
    db.execute("DELETE FROM captures WHERE id=?", (cid,))
    left = _remove_capture_files(c)
    return {"ok": True, "files_left": left}


@route("POST", r"/api/nodes/(\d+)/captures")
def attach_capture(req, m):
    nid = _need_node(m.group(1))
    cid = _int_or_none(req.body.get("capture_id"))
    if not cid or not db.row("SELECT id FROM captures WHERE id=?", (cid,)):
        raise NotFound("captura no encontrada")
    db.execute("INSERT OR IGNORE INTO node_captures (node_id, capture_id) VALUES (?,?)", (nid, cid))
    return _node_out(db.row("SELECT * FROM nodes WHERE id=?", (nid,)))


@route("DELETE", r"/api/nodes/(\d+)/captures/(\d+)")
def detach_capture(req, m):
    db.execute("DELETE FROM node_captures WHERE node_id=? AND capture_id=?",
               (int(m.group(1)), int(m.group(2))))
    return {"ok": True}


@route("GET", r"/api/board")
def get_board(req, m):
    r = db.row("SELECT drawing FROM board WHERE project_id=?", (req.pid(),))
    return {"drawing": r["drawing"] if r else "[]"}


@route("PUT", r"/api/board")
def save_board(req, m):
    pid = int(req.body.get("project_id") or req.pid())
    drawing = req.body.get("drawing")
    if not isinstance(drawing, str):
        drawing = json.dumps(drawing or [])
    db.execute(
        "INSERT INTO board (project_id, drawing, updated_at) VALUES (?,?,?)"
        " ON CONFLICT(project_id) DO UPDATE SET drawing=excluded.drawing, updated_at=excluded.updated_at",
        (pid, drawing, time.time()))
    return {"ok": True}


def _edge_out(e):
    if not e:
        return e
    try:
        e["props"] = json.loads(e.get("props") or "{}")
    except (ValueError, TypeError):
        e["props"] = {}
    return e


@route("GET", r"/api/edges")
def list_edges(req, m):
    return [_edge_out(e) for e in db.rows("SELECT * FROM edges WHERE project_id=? ORDER BY id", (req.pid(),))]


@route("POST", r"/api/edges")
def create_edge(req, m):
    b = req.body
    pid = int(b.get("project_id") or req.pid())
    props = b.get("props", {})
    if not isinstance(props, str):
        props = json.dumps(props or {})
    eid = db.execute(
        "INSERT INTO edges (project_id, source_id, target_id, type, label, props, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (pid, int(b["source_id"]), int(b["target_id"]), b.get("type", ""),
         b.get("label", ""), props, time.time()))
    return _edge_out(db.row("SELECT * FROM edges WHERE id=?", (eid,)))


@route("PATCH", r"/api/edges/(\d+)")
def update_edge(req, m):
    eid = int(m.group(1))
    body = dict(req.body)
    if "props" in body and not isinstance(body["props"], str):
        body["props"] = json.dumps(body["props"] or {})
    _patch("edges", eid, body, {"type", "label", "props", "source_id", "target_id"})
    return _edge_out(db.row("SELECT * FROM edges WHERE id=?", (eid,)))


@route("DELETE", r"/api/edges/(\d+)")
def delete_edge(req, m):
    db.execute("DELETE FROM edges WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


def _cred_out(c):
    """Decrypt the secret and attach the nodes where it is valid (reuse matrix)."""
    if c:
        _decrypt_creds([c])
        c["valid_on"] = db.rows(
            "SELECT cn.node_id, cn.status, n.name, n.type FROM cred_nodes cn "
            "JOIN nodes n ON n.id=cn.node_id WHERE cn.cred_id=? ORDER BY n.id", (c["id"],))
    return c


def _decrypt_creds(rows):
    """Turn stored secrets back into plain text, in place."""
    for r in rows:
        if r is not None and "secret" in r:
            r["secret"] = auth.decrypt_secret(r["secret"])
    return rows


@route("GET", r"/api/creds")
def list_creds(req, m):
    node_id = req.q("node_id")
    sql = ("SELECT c.*, h.address, n.name AS node_name, n.type AS node_type "
           "FROM creds c LEFT JOIN hosts h ON h.id=c.host_id "
           "LEFT JOIN nodes n ON n.id=c.node_id WHERE c.project_id=?")
    params = [req.pid()]
    if node_id:
        sql += (" AND (c.node_id=? OR EXISTS (SELECT 1 FROM cred_nodes cn "
                "WHERE cn.cred_id=c.id AND cn.node_id=?))")
        params += [int(node_id), int(node_id)]
    return [_cred_out(c) for c in db.rows(sql + " ORDER BY c.id DESC", tuple(params))]


@route("GET", r"/api/cred_matrix")
def cred_matrix(req, m):
    """Reuse matrix: credentials x nodes, with each cell's state."""
    pid = req.pid()
    creds = _decrypt_creds(db.rows("SELECT id, username, secret, kind, hash_type, status, node_id "
                                   "FROM creds WHERE project_id=? ORDER BY id", (pid,)))
    nodes = db.rows("SELECT id, name, type, status FROM nodes WHERE project_id=? ORDER BY id", (pid,))
    cells = {}
    for cn in db.rows("SELECT cn.* FROM cred_nodes cn JOIN creds c ON c.id=cn.cred_id "
                      "WHERE c.project_id=?", (pid,)):
        cells["%d:%d" % (cn["cred_id"], cn["node_id"])] = cn["status"]
    return {"creds": creds, "nodes": nodes, "cells": cells}


@route("POST", r"/api/creds")
def create_cred(req, m):
    b = req.body
    pid = int(b.get("project_id") or req.pid())
    cid = db.execute(
        "INSERT INTO creds (project_id, host_id, node_id, username, secret, kind, hash_type,"
        " service, source, status, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (pid, _int_or_none(b.get("host_id")), _int_or_none(b.get("node_id")),
         b.get("username", ""), auth.encrypt_secret(b.get("secret", "")), b.get("kind", "password"),
         b.get("hash_type", ""), b.get("service", ""), b.get("source", ""),
         b.get("status", "untested"), b.get("notes", ""), time.time()))
    return _cred_out(db.row("SELECT * FROM creds WHERE id=?", (cid,)))


@route("PATCH", r"/api/creds/(\d+)")
def update_cred(req, m):
    cid = int(m.group(1))
    body = dict(req.body)
    if "node_id" in body:
        body["node_id"] = _int_or_none(body["node_id"])
    if "secret" in body:
        body["secret"] = auth.encrypt_secret(body["secret"])
    _patch("creds", cid, body,
           {"username", "secret", "kind", "hash_type", "service", "source", "status", "notes", "node_id"})
    return _cred_out(db.row("SELECT * FROM creds WHERE id=?", (cid,)))


@route("DELETE", r"/api/creds/(\d+)")
def delete_cred(req, m):
    db.execute("DELETE FROM creds WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


@route("POST", r"/api/creds/(\d+)/nodes")
def cred_set_node(req, m):
    """Mark on which node a credential is valid/invalid (a matrix cell)."""
    cid = int(m.group(1))
    nid = _need_node(req.body.get("node_id"))
    status = req.body.get("status", "valid")
    if status not in ("valid", "invalid", "untested"):
        raise ValueError("invalid status")
    db.execute(
        "INSERT INTO cred_nodes (cred_id, node_id, status) VALUES (?,?,?)"
        " ON CONFLICT(cred_id, node_id) DO UPDATE SET status=excluded.status",
        (cid, nid, status))
    return _cred_out(db.row("SELECT * FROM creds WHERE id=?", (cid,)))


@route("DELETE", r"/api/creds/(\d+)/nodes/(\d+)")
def cred_del_node(req, m):
    db.execute("DELETE FROM cred_nodes WHERE cred_id=? AND node_id=?",
               (int(m.group(1)), int(m.group(2))))
    return {"ok": True}


_SEV_RANK = ("crit", "high", "med", "low", "info")
_FIND_FIELDS = {"title", "description", "impact", "likelihood", "poc", "remediation",
                "refs", "cvss_version", "cvss_vector", "cvss_score", "severity", "status",
                "retest_at", "detail"}


def _next_code(pid):
    n = db.row("SELECT COUNT(*) c FROM findings WHERE project_id=?", (pid,))["c"]
    return "ATLAS-%03d" % (n + 1)


def _finding_out(f, full=False):
    """Attach the affected assets (and, when full, the evidence)."""
    if not f:
        return f
    fid = f["id"]
    f["assets"] = db.rows(
        "SELECT n.id, n.name, n.type, n.status FROM finding_assets fa "
        "JOIN nodes n ON n.id=fa.node_id WHERE fa.finding_id=? ORDER BY n.id", (fid,))
    if full:
        f["evidence"] = db.rows(
            "SELECT c.id, c.name, c.filename, c.mime, c.width, c.height, c.caption "
            "FROM finding_captures fc JOIN captures c ON c.id=fc.capture_id "
            "WHERE fc.finding_id=? ORDER BY c.id", (fid,))
        for c in f["evidence"]:
            c["url"] = "/api/captures/%d/file" % c["id"]
    return f


def _set_links(fid, table, col, ids):
    """Replace the N:N set (finding_assets / finding_captures)."""
    if ids is None:
        return
    db.execute("DELETE FROM %s WHERE finding_id=?" % table, (fid,))
    for x in ids:
        xi = _int_or_none(x)
        if xi:
            db.execute("INSERT OR IGNORE INTO %s (finding_id, %s) VALUES (?,?)" % (table, col), (fid, xi))


@route("GET", r"/api/findings")
def list_findings(req, m):
    node_id = req.q("node_id")
    sql = "SELECT f.* FROM findings f WHERE f.project_id=?"
    params = [req.pid()]
    if node_id:
        sql += " AND EXISTS (SELECT 1 FROM finding_assets fa WHERE fa.finding_id=f.id AND fa.node_id=?)"
        params.append(int(node_id))
    sql += (" ORDER BY CASE f.severity WHEN 'crit' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 "
            "WHEN 'low' THEN 3 ELSE 4 END, f.id DESC")
    return [_finding_out(f) for f in db.rows(sql, tuple(params))]


@route("GET", r"/api/findings/(\d+)")
def get_finding(req, m):
    f = _finding_out(db.row("SELECT * FROM findings WHERE id=?", (int(m.group(1)),)), full=True)
    if not f:
        raise NotFound("hallazgo no encontrado")
    return f


@route("POST", r"/api/findings")
def create_finding(req, m):
    b = req.body
    pid = int(b.get("project_id") or req.pid())
    now = time.time()
    code = (b.get("code") or "").strip() or _next_code(pid)
    node_id = _int_or_none(b.get("node_id"))
    fid = db.execute(
        "INSERT INTO findings (project_id, host_id, node_id, code, title, detail, description,"
        " impact, likelihood, poc, remediation, refs, cvss_version, cvss_vector, cvss_score,"
        " severity, status, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (pid, _int_or_none(b.get("host_id")), node_id, code,
         b.get("title", "").strip() or "Untitled finding", b.get("detail", ""),
         b.get("description", ""), b.get("impact", ""), b.get("likelihood", ""),
         b.get("poc", ""), b.get("remediation", ""), b.get("refs", ""),
         b.get("cvss_version", ""), b.get("cvss_vector", ""),
         b.get("cvss_score") if b.get("cvss_score") not in ("", None) else None,
         b.get("severity", "info"), b.get("status", "open"), now, now))
    assets = b.get("assets")
    if assets is None and node_id:
        assets = [node_id]
    _set_links(fid, "finding_assets", "node_id", assets)
    _set_links(fid, "finding_captures", "capture_id", b.get("evidence"))
    return _finding_out(db.row("SELECT * FROM findings WHERE id=?", (fid,)), full=True)


@route("PATCH", r"/api/findings/(\d+)")
def update_finding(req, m):
    fid = int(m.group(1))
    body = dict(req.body)
    body["updated_at"] = time.time()
    _patch("findings", fid, body, _FIND_FIELDS | {"updated_at"})
    if "assets" in body:
        _set_links(fid, "finding_assets", "node_id", body["assets"])
    if "evidence" in body:
        _set_links(fid, "finding_captures", "capture_id", body["evidence"])
    return _finding_out(db.row("SELECT * FROM findings WHERE id=?", (fid,)), full=True)


@route("DELETE", r"/api/findings/(\d+)")
def delete_finding(req, m):
    db.execute("DELETE FROM findings WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


@route("POST", r"/api/findings/(\d+)/assets")
def attach_finding_asset(req, m):
    fid = int(m.group(1))
    nid = _need_node(req.body.get("node_id"))
    db.execute("INSERT OR IGNORE INTO finding_assets (finding_id, node_id) VALUES (?,?)", (fid, nid))
    return _finding_out(db.row("SELECT * FROM findings WHERE id=?", (fid,)), full=True)


@route("DELETE", r"/api/findings/(\d+)/assets/(\d+)")
def detach_finding_asset(req, m):
    db.execute("DELETE FROM finding_assets WHERE finding_id=? AND node_id=?",
               (int(m.group(1)), int(m.group(2))))
    return {"ok": True}


@route("POST", r"/api/findings/(\d+)/captures")
def attach_finding_capture(req, m):
    fid = int(m.group(1))
    cid = _int_or_none(req.body.get("capture_id"))
    if not cid or not db.row("SELECT id FROM captures WHERE id=?", (cid,)):
        raise NotFound("captura no encontrada")
    db.execute("INSERT OR IGNORE INTO finding_captures (finding_id, capture_id) VALUES (?,?)", (fid, cid))
    return _finding_out(db.row("SELECT * FROM findings WHERE id=?", (fid,)), full=True)


@route("DELETE", r"/api/findings/(\d+)/captures/(\d+)")
def detach_finding_capture(req, m):
    db.execute("DELETE FROM finding_captures WHERE finding_id=? AND capture_id=?",
               (int(m.group(1)), int(m.group(2))))
    return {"ok": True}


@route("GET", r"/api/deps")
def get_deps(req, m):
    """Which optional dependencies are present, so the UI can warn accurately."""
    return mdown.deps()


@route("GET", r"/api/docs")
def list_docs(req, m):
    return db.rows(
        "SELECT id, title, created_at, updated_at, LENGTH(body) AS size "
        "FROM docs WHERE project_id=? ORDER BY updated_at DESC", (req.pid(),))


@route("POST", r"/api/docs")
def create_doc(req, m):
    b = req.body
    pid = int(b.get("project_id") or req.pid())
    now = time.time()
    did = db.execute(
        "INSERT INTO docs (project_id, title, body, created_at, updated_at)"
        " VALUES (?,?,?,?,?)",
        (pid, (b.get("title") or "Untitled report").strip(), b.get("body", ""), now, now))
    return db.row("SELECT * FROM docs WHERE id=?", (did,))


@route("GET", r"/api/docs/(\d+)")
def get_doc(req, m):
    d = db.row("SELECT * FROM docs WHERE id=?", (int(m.group(1)),))
    if not d:
        raise NotFound("documento no encontrado")
    return d


@route("PATCH", r"/api/docs/(\d+)")
def update_doc(req, m):
    did = int(m.group(1))
    body = dict(req.body)
    body["updated_at"] = time.time()
    _patch("docs", did, body, {"title", "body", "updated_at"})
    return db.row("SELECT * FROM docs WHERE id=?", (did,))


@route("DELETE", r"/api/docs/(\d+)")
def delete_doc(req, m):
    db.execute("DELETE FROM docs WHERE id=?", (int(m.group(1)),))
    return {"ok": True}


@route("POST", r"/api/render")
def render_md(req, m):
    """Preview of the text currently in the editor (not yet saved)."""
    pid = int(req.body.get("project_id") or req.pid())
    nodes = db.rows("SELECT id, name, type, status FROM nodes WHERE project_id=?", (pid,))
    text = req.body.get("body") or ""
    return {"html": mdown.to_html(text, nodes),
            "css": mdown.pygments_css(),
            "links": mdown.wikilink_names(text)}


def _doc_and_project(did):
    d = db.row("SELECT * FROM docs WHERE id=?", (did,))
    if not d:
        raise NotFound("documento no encontrado")
    p = db.row("SELECT * FROM projects WHERE id=?", (d["project_id"],))
    return d, p


def _archive_export(pid, stem, ext, data):
    """Keep a copy of an export in the project's exports/ folder."""
    name = "%s-%s%s" % (time.strftime("%Y%m%d-%H%M"), _slug(stem, 60), ext)
    try:
        path = os.path.join(db.exports_dir_for(pid), name)
        with open(path, "wb") as fh:
            fh.write(data)
        return path
    except (OSError, ValueError):
        return ""


@route("GET", r"/api/docs/(\d+)/export\.md")
def export_md(req, m):
    d, _ = _doc_and_project(int(m.group(1)))
    body = (d["body"] or "").encode("utf-8")
    saved = _archive_export(d["project_id"], d["title"], ".md", body)
    return Raw(body, "text/markdown; charset=utf-8",
               filename=_slug(d["title"]) + ".md", download=True, saved_to=saved)


@route("GET", r"/api/docs/(\d+)/export\.pdf")
def export_pdf(req, m):
    d, p = _doc_and_project(int(m.group(1)))
    pid = d["project_id"]
    nodes = db.rows("SELECT id, name, type, status FROM nodes WHERE project_id=?", (pid,))

    def lookup(cid):
        return db.row("SELECT * FROM captures WHERE id=?", (cid,))

    try:
        pdf = mdown.to_pdf(d["body"] or "", title=d["title"], project=p, nodes=nodes,
                           captures_dir=[db.captures_dir_for(pid), db.legacy_captures_dir()],
                           capture_lookup=lookup)
    except RuntimeError as e:
        raise ValueError(str(e))
    saved = _archive_export(pid, d["title"], ".pdf", pdf)
    return Raw(pdf, "application/pdf", filename=_slug(d["title"]) + ".pdf",
               download=req.flag("download"), saved_to=saved)


@route("POST", r"/api/projects/(\d+)/exports/map")
def archive_board_image(req, m):
    """Archive a board image. The PNG is rendered in the browser and posted here"""
    pid = int(m.group(1))
    if not db.row("SELECT id FROM projects WHERE id=?", (pid,)):
        raise NotFound("project not found")
    raw = (req.body or {}).get("data") or ""
    if isinstance(raw, str) and raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError):
        raise ValueError("invalid image (base64)")
    if not data:
        raise ValueError("empty image")
    mime, ext = _sniff(data)
    if not mime:
        raise ValueError("unsupported format: the board exports PNG")
    stem = (req.body.get("name") or "board").strip() or "board"
    saved = _archive_export(pid, os.path.splitext(stem)[0], ext, data)
    if not saved:
        raise ValueError("could not write to the project exports folder")
    return {"ok": True, "saved_to": saved, "folder": db.project_folder(pid)}


def _md_table(headers, rows):
    if not rows:
        return ""
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        cells = [str(x if x not in (None, "") else "—").replace("|", "\\|").replace("\n", " ")
                 for x in r]
        out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)


@route("GET", r"/api/snippets/node")
def snippet_node(req, m):
    """Markdown table for a node record: identity, ports, users, creds."""
    nid = _need_node(req.q("node_id"))
    n = db.row("SELECT * FROM nodes WHERE id=?", (nid,))
    try:
        props = json.loads(n["props"] or "{}")
    except (ValueError, TypeError):
        props = {}
    name = n["name"] or "node"
    L = ["### %s" % name, ""]
    L.append(_md_table(["Field", "Value"], [
        ["Type", n["type"]], ["Status", n["status"]],
        ["IP", props.get("ip", "")], ["Hostname", props.get("hostname", "")],
        ["OS", props.get("os", "")], ["Domain", props.get("domain", "")]]))
    if props.get("text"):
        L += ["", props["text"]]

    svcs = db.rows("SELECT * FROM node_services WHERE node_id=? ORDER BY port", (nid,))
    if svcs:
        L += ["", "**Ports and services**", "",
              _md_table(["Port", "Service", "Product / version", "State"],
                        [["%d/%s" % (s["port"], s["proto"]), s["name"],
                          (" ".join([s["product"] or "", s["version"] or ""]).strip()),
                          s["state"]] for s in svcs])]

    users = db.rows("SELECT * FROM node_users WHERE node_id=? ORDER BY id", (nid,))
    if users:
        L += ["", "**Users**", "",
              _md_table(["User", "Domain", "Kind", "Privilege", "Status"],
                        [[u["username"], u["domain"], u["kind"], u["privilege"],
                          u["status"]] for u in users])]

    creds = _decrypt_creds(db.rows("SELECT * FROM creds WHERE node_id=? ORDER BY id", (nid,)))
    if creds:
        L += ["", "**Credentials obtained**", "",
              _md_table(["User", "Secret", "Kind", "Service", "Status"],
                        [[c["username"], "`%s`" % (c["secret"] or ""), c["kind"],
                          c["service"], c["status"]] for c in creds])]

    caps = db.rows(
        "SELECT c.* FROM node_captures nc JOIN captures c ON c.id=nc.capture_id "
        "WHERE nc.node_id=? ORDER BY c.id", (nid,))
    if caps:
        L += ["", "**Evidence**", ""]
        for c in caps:
            L.append("![%s](/api/captures/%d/file)" % (c["caption"] or c["name"], c["id"]))
            L.append("")
    return {"markdown": "\n".join(L).rstrip() + "\n"}


@route("GET", r"/api/snippets/capture")
def snippet_capture(req, m):
    cid = _int_or_none(req.q("capture_id"))
    c = db.row("SELECT * FROM captures WHERE id=?", (cid,)) if cid else None
    if not c:
        raise NotFound("capture not found")
    return {"markdown": "![%s](/api/captures/%d/file)\n"
                        % (c["caption"] or c["name"] or "capture", c["id"])}


_SEV_LABEL = {"crit": "Critical", "high": "High", "med": "Medium", "low": "Low", "info": "Informational"}
_STATUS_LABEL = {"open": "Open", "confirmed": "Confirmed", "remediated": "Remediated",
                 "accepted": "Risk accepted", "retest": "Pending retest"}


@route("GET", r"/api/snippets/findings")
def snippet_findings(req, m):
    """The project's (or a node's) findings as complete report sections."""
    pid = req.pid()
    node_id = _int_or_none(req.q("node_id"))
    sql = "SELECT f.* FROM findings f WHERE f.project_id=?"
    params = [pid]
    if node_id:
        sql += " AND EXISTS (SELECT 1 FROM finding_assets fa WHERE fa.finding_id=f.id AND fa.node_id=?)"
        params.append(node_id)
    rows = db.rows(sql + " ORDER BY CASE f.severity WHEN 'crit' THEN 0 WHEN 'high' THEN 1"
                   " WHEN 'med' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, f.id", tuple(params))
    if not rows:
        return {"markdown": "_No findings recorded._\n"}

    def assets_of(fid):
        return db.rows("SELECT n.name FROM finding_assets fa JOIN nodes n ON n.id=fa.node_id "
                       "WHERE fa.finding_id=? ORDER BY n.id", (fid,))

    L = ["## Findings", "",
         _md_table(["ID", "Finding", "Severity", "CVSS", "Assets", "Status"],
                   [[f["code"] or ("#%d" % f["id"]), f["title"], _SEV_LABEL.get(f["severity"], f["severity"]),
                     ("%.1f" % f["cvss_score"]) if f["cvss_score"] is not None else "\u2014",
                     ", ".join(a["name"] for a in assets_of(f["id"])) or "\u2014",
                     _STATUS_LABEL.get(f["status"], f["status"])] for f in rows]), ""]
    for f in rows:
        code = (f["code"] + " · ") if f["code"] else ""
        L.append("### %s%s" % (code, f["title"]))
        L.append("")
        meta = "**Severity:** %s" % _SEV_LABEL.get(f["severity"], f["severity"])
        if f["cvss_score"] is not None:
            meta += "  ·  **CVSS %s:** %.1f" % (f["cvss_version"] or "", f["cvss_score"])
        meta += "  \u00b7  **Status:** %s" % _STATUS_LABEL.get(f["status"], f["status"])
        L += [meta, ""]
        if f["cvss_vector"]:
            L += ["`%s`" % f["cvss_vector"], ""]
        assets = assets_of(f["id"])
        if assets:
            L += ["**Affected assets:** " + ", ".join("[[%s]]" % a["name"] for a in assets), ""]
        sections = [("Description", f["description"] or f["detail"]), ("Impact", f["impact"]),
                    ("Reproduction / PoC", f["poc"]), ("Remediation", f["remediation"])]
        for heading, text in sections:
            if (text or "").strip():
                L += ["**%s**" % heading, "", text.strip(), ""]
        if (f["refs"] or "").strip():
            refs = [r.strip() for r in f["refs"].splitlines() if r.strip()]
            L += ["**References**", ""] + ["- " + r for r in refs] + [""]
        caps = db.rows("SELECT c.id, c.caption, c.name FROM finding_captures fc "
                       "JOIN captures c ON c.id=fc.capture_id WHERE fc.finding_id=? ORDER BY c.id",
                       (f["id"],))
        if caps:
            L += ["**Evidence**", ""]
            for c in caps:
                L += ["![%s](/api/captures/%d/file)" % (c["caption"] or c["name"] or "evidence", c["id"]), ""]
    return {"markdown": "\n".join(L)}


@route("GET", r"/api/snippets/template")
def snippet_template(req, m):
    """Pentest report skeleton, pre-filled with the project's data."""
    pid = req.pid()
    p = db.row("SELECT * FROM projects WHERE id=?", (pid,))
    nodes = db.rows("SELECT * FROM nodes WHERE project_id=? ORDER BY id", (pid,))
    one = lambda sql: db.row(sql, (pid,))["c"]
    n_ports = one("SELECT COUNT(*) c FROM node_services s JOIN nodes n ON n.id=s.node_id "
                  "WHERE n.project_id=? AND s.state='open'")
    n_creds = one("SELECT COUNT(*) c FROM creds WHERE project_id=?")
    n_caps = one("SELECT COUNT(*) c FROM captures WHERE project_id=?")
    finds = db.rows("SELECT severity, COUNT(*) c FROM findings WHERE project_id=? "
                    "GROUP BY severity", (pid,))
    by_sev = {f["severity"]: f["c"] for f in finds}
    pwned = [n for n in nodes if n["status"] == "pwned"]
    today = time.strftime("%Y-%m-%d")

    L = ["# Audit report \u2014 %s" % (p["name"] if p else "Audit"), "",
         "**Date:** %s  " % today,
         "**Scope:** %s  " % ((p or {}).get("scope") or "_to be defined_"),
         "**Classification:** CONFIDENTIAL", "",
         "---", "",
         "## 1. Executive summary", "",
         "A security audit was carried out over the agreed scope. During the "
         "engagement **%d assets** were identified, of which **%d were "
         "compromised**, and **%d credentials** and **%d screenshots** were "
         "collected." % (len(nodes), len(pwned), n_creds, n_caps), "",
         "_(Write the conclusion for management here: business impact and "
         "priority of action.)_", "",
         _md_table(["Severity", "Findings"],
                   [["Critical", by_sev.get("crit", 0)], ["High", by_sev.get("high", 0)],
                    ["Medium", by_sev.get("med", 0)], ["Low", by_sev.get("low", 0)],
                    ["Informational", by_sev.get("info", 0)]]), "",
         "## 2. Scope and methodology", "",
         "**Scope:** %s" % ((p or {}).get("scope") or "_pending_"), "",
         "The review followed the usual phases of reconnaissance, enumeration, "
         "exploitation and post-exploitation, documenting each step with evidence.", "",
         "## 3. Identified assets", "",
         _md_table(["Asset", "Type", "IP / host", "Status"],
                   [[n["name"] or "\u2014", n["type"],
                     (json.loads(n["props"] or "{}").get("ip")
                      or json.loads(n["props"] or "{}").get("hostname") or ""),
                     n["status"]] for n in nodes]) or "_No assets recorded._", "",
         "Open ports detected: **%d**." % n_ports, "",
         "## 4. Findings", "",
         "_(Use the \u00abFindings\u00bb button on the toolbar to insert them here.)_", "",
         "## 5. Attack path", "",
         "_(Describe the chain: from where you started to the final compromise. "
         "Reference assets with [[node name]].)_", ""]
    if pwned:
        L.append("Compromised assets: " + ", ".join("[[%s]]" % (n["name"] or "?")
                                                    for n in pwned))
        L.append("")
    L += ["## 6. Evidence", "",
          "_(Insert vault captures with the \u00abCapture\u00bb button.)_", "",
          "## 7. Conclusions and recommendations", "",
          "1. _Priority recommendation._", "2. _Second recommendation._", "",
          "---", "",
          "_Report generated with ATLAS on %s._" % today, ""]
    return {"markdown": "\n".join(L)}


@route("GET", r"/api/session")
def get_session(req, m):
    """Whether this browser is logged in. Drives the login screen."""
    if not auth_on():
        return {"auth": False, "authenticated": True, "username": "", "vault": False}
    ok = any(auth.valid_session(t) for t in req.session_tokens())
    return {"auth": True, "authenticated": ok,
            "username": auth.username_of() if ok else "",
            "vault": ok and auth.unlocked(),
            "crypto": crypto.backend_name() if ok else ""}


@route("POST", r"/api/login")
def do_login(req, m):
    if not auth_on():
        return {"authenticated": True}
    ip = req.client_ip()
    wait = auth.locked_out(ip)
    if wait:
        raise Throttled("too many failed attempts, try again in %ds" % wait)
    b = req.body or {}
    try:
        dek = auth.verify_login(b.get("username") or "", b.get("password") or "")
    except auth.AuthError as e:
        auth.note_failure(ip)
        raise Unauthorized(str(e))
    auth.note_success(ip)
    auth.unlock(dek)
    auth.encrypt_vault_rows()
    token = auth.new_session(CONFIG.get("session_hours", 12))
    req.h.set_session_cookie = token
    return {"authenticated": True, "username": auth.username_of(),
            "vault": True, "crypto": crypto.backend_name()}


@route("POST", r"/api/logout")
def do_logout(req, m):
    for tok in req.session_tokens():
        auth.drop_session(tok)
    req.h.clear_session_cookie = True
    if not auth.any_session():
        auth.lock()
    return {"authenticated": False}


@route("POST", r"/api/password")
def do_change_password(req, m):
    """Change the password from the app: verify, then re-seal the same data key."""
    if not auth_on():
        raise ValueError("no password is configured; run: python3 atlas.py --setup")
    b = req.body or {}
    current, new = b.get("current") or "", b.get("new") or ""
    if len(new) < auth.MIN_PASSWORD:
        raise ValueError("the new password must be at least %d characters" % auth.MIN_PASSWORD)
    if new == current:
        raise ValueError("the new password is the same as the current one")
    ip = req.client_ip()
    wait = auth.locked_out(ip)
    if wait:
        raise Throttled("too many failed attempts, try again in %ds" % wait)
    try:
        dek = auth.change_password(current, new, username=(b.get("username") or "").strip() or None)
    except auth.AuthError:
        auth.note_failure(ip)
        raise Unauthorized("the current password is wrong")
    auth.note_success(ip)
    auth.unlock(dek)
    auth.drop_all_sessions()
    req.h.set_session_cookie = auth.new_session(CONFIG.get("session_hours", 12))
    return {"ok": True, "username": auth.username_of()}


def auth_on():
    """True when a password has been set up. Cached: this runs on every request."""
    return bool(CONFIG) and bool(CONFIG.get("_auth_on"))


def _patch(table, row_id, body, allowed):
    fields = {k: v for k, v in body.items() if k in allowed}
    if not fields:
        return
    sets = ", ".join("%s=?" % k for k in fields)
    db.execute("UPDATE %s SET %s WHERE id=?" % (table, sets), tuple(fields.values()) + (row_id,))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    set_session_cookie = None
    clear_session_cookie = False

    def log_message(self, *a):
        pass

    def _authorised(self, path, method):
        """Every path needs a session except the login screen and its assets."""
        if not auth_on():
            return True
        if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
            return True
        return any(auth.valid_session(t)
                   for t in cookie_values(self.headers.get("Cookie"), SESSION_COOKIE))

    def _cross_origin(self, method):
        """Reject state-changing requests that did not come from our own page."""
        if method == "GET":
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return False
        host = self.headers.get("Host") or ""
        try:
            o = urlparse(origin)
        except ValueError:
            return True
        return o.netloc != host

    def _host_guard(self):
        """Reject requests whose Host header could be a DNS-rebinding attack."""
        if host_allowed(self.headers.get("Host")):
            return True
        self._json({"error": "host not allowed"}, 403)
        return False

    def do_GET(self):
        if not self._host_guard():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", ""):
            return self._serve_static("index.html")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        return self._api("GET", parsed)

    def do_POST(self):
        return self._api("POST", urlparse(self.path))

    def do_PATCH(self):
        return self._api("PATCH", urlparse(self.path))

    def do_PUT(self):
        return self._api("PUT", urlparse(self.path))

    def do_DELETE(self):
        return self._api("DELETE", urlparse(self.path))

    def _api(self, method, parsed):
        if not self._host_guard():
            return
        if not self._authorised(parsed.path, method):
            return self._json({"error": "authentication required", "auth": True}, 401)
        if self._cross_origin(method):
            return self._json({"error": "cross-origin request refused"}, 403)
        body = None
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.close_connection = True
            return self._json({"error": "body too large (max %d MB)"
                               % (MAX_BODY // (1024 * 1024))}, 413)
        if length:
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return self._json({"error": "invalid json"}, 400)
        query = parse_qs(parsed.query)
        for rmethod, rx, fn in _ROUTES:
            if rmethod != method:
                continue
            mt = rx.match(parsed.path)
            if mt:
                try:
                    out = fn(Req(self, query, body), mt)
                except Unauthorized as e:
                    return self._json({"error": str(e), "auth": True}, 401)
                except auth.VaultLocked as e:
                    return self._json({"error": str(e), "auth": True}, 401)
                except Throttled as e:
                    return self._json({"error": str(e)}, 429)
                except NotFound as e:
                    return self._json({"error": e.args[0] if e.args else "not found"}, 404)
                except KeyError as e:
                    return self._json({"error": "missing field %s" % (e.args[0] if e.args else "?")}, 400)
                except ValueError as e:
                    return self._json({"error": str(e)}, 400)
                except Exception:
                    traceback.print_exc()
                    return self._json({"error": "internal server error"}, 500)
                if isinstance(out, Raw):
                    return self._raw(out)
                return self._json(out)
        return self._json({"error": "no encontrado"}, 404)

    def _serve_static(self, rel):
        rel = rel.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml",
            ".ico": "image/x-icon", ".png": "image/png", ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
        }.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    def _raw(self, r):
        self.send_response(200)
        self.send_header("Content-Type", r.ctype)
        self.send_header("Content-Length", str(len(r.data)))
        self._security_headers()
        if r.cache:
            self.send_header("Cache-Control", "private, max-age=604800")
        if r.download and r.filename:
            stem, ext = os.path.splitext(r.filename)
            safe = _slug(stem) + (ext if re.match(r"^\.[a-z0-9]{1,5}$", ext.lower()) else "")
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % safe)
        if r.saved_to:
            self.send_header("X-Atlas-Saved-To", os.path.basename(r.saved_to))
        self.end_headers()
        self.wfile.write(r.data)

    def _session_headers(self):
        """Emit Set-Cookie for the login/logout routes."""
        secure = "; Secure" if CONFIG.get("_tls_active") else ""
        if self.set_session_cookie:
            self.send_header("Set-Cookie", "%s=%s; HttpOnly; SameSite=Strict; Path=/%s"
                             % (SESSION_COOKIE, self.set_session_cookie, secure))
            self.set_session_cookie = None
        elif self.clear_session_cookie:
            self.send_header("Set-Cookie", "%s=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0%s"
                             % (SESSION_COOKIE, secure))
            self.clear_session_cookie = False

    def _security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")

    def _json(self, obj, code=200):
        data = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self._session_headers()
        self.end_headers()
        self.wfile.write(data)


class AtlasServer(ThreadingHTTPServer):
    allow_reuse_address = (os.name != "nt")

    def server_bind(self):
        if os.name == "nt":
            try:
                import socket
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except (AttributeError, OSError):
                pass
        super().server_bind()


def serve(host, port, cfg=None, data_dir=None):
    """Build the HTTP(S) server. Returns (httpd, scheme)."""
    global CONFIG
    CONFIG = dict(cfg or {})
    db.init()
    CONFIG["_auth_on"] = auth.configured()
    httpd = AtlasServer((host, port), Handler)

    if not CONFIG.get("tls"):
        CONFIG["_tls_active"] = False
        return httpd, "http"

    cert, key = auth.resolve_cert(CONFIG, data_dir or os.getcwd())
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(certfile=cert, keyfile=key)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    CONFIG["_tls_active"] = True
    CONFIG["_cert_path"] = cert
    return httpd, "https"
