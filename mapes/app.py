import base64
import binascii
import mimetypes
import re
import sqlite3
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, render_template

from . import crypto, db
from .config import load_config, save_config
from .db import get_connection, init_db
from .paths import resource_root


def _slug(text, limit=60):
    text = re.sub(r"[^\w\-]+", "_", (text or "").strip()).strip("_")
    return (text or "file")[:limit]


def create_app():
    root = resource_root()
    app = Flask(
        __name__,
        template_folder=str(root / "templates"),
        static_folder=str(root / "static"),
    )
    # This app only ever runs as a single local desktop window (pywebview's
    # WebView2/WebKit view keeps its own persistent HTTP cache across
    # restarts, like a normal browser profile), so caching static files at
    # all just means CSS/JS fixes silently keep not applying after an
    # update - there's no CDN or multi-user traffic here to actually
    # benefit from it. Always serve the current file from disk.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    @app.after_request
    def _no_cache(response):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        return response

    init_db()

    @app.teardown_appcontext
    def _close_db_connection(exception=None):
        # Guaranteed to run even when the request raised, so a failed write
        # can never leak an open connection holding the database's write
        # lock - see the docstring on db.get_connection().
        conn = g.pop("db_conn", None)
        if conn is not None:
            conn.close()

    @app.errorhandler(sqlite3.IntegrityError)
    def handle_integrity_error(err):
        # Most commonly: a node referenced by an edge/capture/cred/finding was
        # already deleted (stale id from a leftover UI selection). Report it
        # as a normal 400 instead of a raw 500 page.
        return jsonify({"error": "That node no longer exists - it may have been deleted."}), 400

    @app.errorhandler(Exception)
    def handle_unexpected_error(err):
        from werkzeug.exceptions import HTTPException

        if isinstance(err, HTTPException):
            return err
        app.logger.exception("Unhandled error")
        return jsonify({"error": str(err) or err.__class__.__name__}), 500

    # ---------- boards ----------

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/boards")
    def list_boards():
        conn = get_connection()
        rows = conn.execute("SELECT * FROM boards ORDER BY id").fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/boards")
    def create_board():
        data = request.get_json(force=True) or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name is required"}), 400
        description = data.get("description", "")
        conn = get_connection()
        cur = conn.execute(
            "INSERT INTO boards (name, description) VALUES (?, ?)",
            (name, description),
        )
        conn.commit()
        board = conn.execute(
            "SELECT * FROM boards WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return jsonify(dict(board)), 201

    @app.put("/api/boards/<int:board_id>")
    def update_board(board_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        board = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
        if not board:
            return jsonify({"error": "not found"}), 404
        name = data.get("name", board["name"])
        description = data.get("description", board["description"])
        conn.execute(
            "UPDATE boards SET name = ?, description = ? WHERE id = ?",
            (name, description, board_id),
        )
        conn.commit()
        board = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
        return jsonify(dict(board))

    @app.delete("/api/boards/<int:board_id>")
    def delete_board(board_id):
        conn = get_connection()
        conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))
        conn.commit()
        return "", 204

    # ---------- nodes ----------

    @app.get("/api/boards/<int:board_id>/nodes")
    def list_nodes(board_id):
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM nodes WHERE board_id = ? ORDER BY id", (board_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/boards/<int:board_id>/nodes")
    def create_node(board_id):
        data = request.get_json(force=True) or {}
        title = (data.get("title") or "Untitled").strip()
        conn = get_connection()
        cur = conn.execute(
            """INSERT INTO nodes (board_id, type, title, content, tags, color, x, y, width, height)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                board_id,
                data.get("type", "note"),
                title,
                data.get("content", ""),
                data.get("tags", ""),
                data.get("color", "#4f8cff"),
                data.get("x", 40),
                data.get("y", 40),
                data.get("width"),
                data.get("height"),
            ),
        )
        conn.commit()
        node = conn.execute("SELECT * FROM nodes WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(dict(node)), 201

    @app.put("/api/nodes/<int:node_id>")
    def update_node(node_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        node = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if not node:
            return jsonify({"error": "not found"}), 404
        fields = {}
        for key in ("type", "title", "content", "tags", "color", "x", "y", "width", "height"):
            if key in data:
                fields[key] = data[key]
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE nodes SET {set_clause}, updated_at = datetime('now') WHERE id = ?",
                (*fields.values(), node_id),
            )
            conn.commit()
        node = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        return jsonify(dict(node))

    @app.delete("/api/nodes/<int:node_id>")
    def delete_node(node_id):
        conn = get_connection()
        conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        conn.commit()
        return "", 204

    # ---------- edges ----------

    @app.get("/api/boards/<int:board_id>/edges")
    def list_edges(board_id):
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM edges WHERE board_id = ? ORDER BY id", (board_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/boards/<int:board_id>/edges")
    def create_edge(board_id):
        data = request.get_json(force=True) or {}
        source_id = data.get("source_id")
        target_id = data.get("target_id")
        if not source_id or not target_id:
            return jsonify({"error": "source_id and target_id are required"}), 400
        if source_id == target_id:
            return jsonify({"error": "cannot connect a node to itself"}), 400
        conn = get_connection()
        cur = conn.execute(
            "INSERT INTO edges (board_id, source_id, target_id, label) VALUES (?, ?, ?, ?)",
            (board_id, source_id, target_id, data.get("label", "")),
        )
        conn.commit()
        edge = conn.execute("SELECT * FROM edges WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(dict(edge)), 201

    @app.delete("/api/edges/<int:edge_id>")
    def delete_edge(edge_id):
        conn = get_connection()
        conn.execute("DELETE FROM edges WHERE id = ?", (edge_id,))
        conn.commit()
        return "", 204

    # ---------- vault (attachments/captures) ----------

    @app.get("/api/boards/<int:board_id>/capture-folders")
    def list_capture_folders(board_id):
        parent_id = request.args.get("parent_id")
        conn = get_connection()
        if parent_id:
            rows = conn.execute(
                "SELECT * FROM capture_folders WHERE board_id = ? AND parent_id = ? ORDER BY name",
                (board_id, parent_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM capture_folders WHERE board_id = ? AND parent_id IS NULL ORDER BY name",
                (board_id,),
            ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/boards/<int:board_id>/capture-folders")
    def create_capture_folder(board_id):
        data = request.get_json(force=True) or {}
        name = (data.get("name") or "New folder").strip() or "New folder"
        parent_id = data.get("parent_id") or None
        conn = get_connection()
        cur = conn.execute(
            "INSERT INTO capture_folders (board_id, parent_id, name) VALUES (?, ?, ?)",
            (board_id, parent_id, name),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM capture_folders WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(dict(row)), 201

    @app.patch("/api/capture-folders/<int:folder_id>")
    def rename_capture_folder(folder_id):
        data = request.get_json(force=True) or {}
        name = (data.get("name") or "").strip()
        conn = get_connection()
        if name:
            conn.execute("UPDATE capture_folders SET name = ? WHERE id = ?", (name, folder_id))
            conn.commit()
        row = conn.execute("SELECT * FROM capture_folders WHERE id = ?", (folder_id,)).fetchone()
        if not row:
            return jsonify({"error": "not found"}), 404
        return jsonify(dict(row))

    @app.delete("/api/capture-folders/<int:folder_id>")
    def delete_capture_folder(folder_id):
        conn = get_connection()
        folder = conn.execute("SELECT * FROM capture_folders WHERE id = ?", (folder_id,)).fetchone()
        if folder:
            # ON DELETE CASCADE removes the DB rows for every capture and
            # sub-folder nested under this one, but not their files on
            # disk - collect those first (recursively) so they get
            # unlinked too, same as a normal single-capture delete.
            caps = conn.execute(
                """WITH RECURSIVE sub(id) AS (
                       SELECT id FROM capture_folders WHERE id = ?
                       UNION ALL
                       SELECT capture_folders.id FROM capture_folders
                       JOIN sub ON capture_folders.parent_id = sub.id
                   )
                   SELECT captures.* FROM captures JOIN sub ON captures.folder_id = sub.id""",
                (folder_id,),
            ).fetchall()
            for cap in caps:
                (db.captures_dir_for(cap["board_id"]) / cap["filename"]).unlink(missing_ok=True)
            conn.execute("DELETE FROM capture_folders WHERE id = ?", (folder_id,))
            conn.commit()
        return "", 204

    def _duplicate_capture_file(conn, cap, folder_id, rename=False):
        caption = cap["caption"]
        if rename:
            caption = f"{caption} copy" if caption else caption
        cur = conn.execute(
            """INSERT INTO captures (board_id, node_id, folder_id, filename, orig_name, mime, size, caption, tags)
               VALUES (?, NULL, ?, '', ?, ?, ?, ?, ?)""",
            (cap["board_id"], folder_id, cap["orig_name"], cap["mime"], cap["size"], caption, cap["tags"]),
        )
        new_id = cur.lastrowid
        ext = Path(cap["orig_name"]).suffix or (mimetypes.guess_extension(cap["mime"]) or "")
        filename = f"cap-{new_id}-{_slug(Path(cap['orig_name']).stem)}{ext}"
        src = db.captures_dir_for(cap["board_id"]) / cap["filename"]
        if src.is_file():
            (db.captures_dir_for(cap["board_id"]) / filename).write_bytes(src.read_bytes())
        conn.execute("UPDATE captures SET filename = ? WHERE id = ?", (filename, new_id))
        return new_id

    def _duplicate_folder_tree(conn, folder, parent_id, rename):
        name = f"{folder['name']} copy" if rename else folder["name"]
        cur = conn.execute(
            "INSERT INTO capture_folders (board_id, parent_id, name) VALUES (?, ?, ?)",
            (folder["board_id"], parent_id, name),
        )
        new_folder_id = cur.lastrowid
        for cap in conn.execute("SELECT * FROM captures WHERE folder_id = ?", (folder["id"],)).fetchall():
            _duplicate_capture_file(conn, cap, new_folder_id)
        for sub in conn.execute("SELECT * FROM capture_folders WHERE parent_id = ?", (folder["id"],)).fetchall():
            _duplicate_folder_tree(conn, sub, new_folder_id, rename=False)
        return new_folder_id

    @app.post("/api/capture-folders/<int:folder_id>/duplicate")
    def duplicate_capture_folder(folder_id):
        conn = get_connection()
        folder = conn.execute("SELECT * FROM capture_folders WHERE id = ?", (folder_id,)).fetchone()
        if not folder:
            return jsonify({"error": "not found"}), 404
        new_id = _duplicate_folder_tree(conn, folder, folder["parent_id"], rename=True)
        conn.commit()
        row = conn.execute("SELECT * FROM capture_folders WHERE id = ?", (new_id,)).fetchone()
        return jsonify(dict(row)), 201

    @app.get("/api/boards/<int:board_id>/captures")
    def list_captures(board_id):
        node_id = request.args.get("node_id")
        folder_id = request.args.get("folder_id")
        conn = get_connection()
        sql = ("SELECT id, board_id, node_id, folder_id, orig_name, mime, size, caption, tags, created_at "
               "FROM captures WHERE board_id = ?")
        params = [board_id]
        if node_id:
            sql += " AND node_id = ?"
            params.append(node_id)
        elif folder_id:
            sql += " AND folder_id = ?"
            params.append(folder_id)
        else:
            sql += " AND folder_id IS NULL"
        sql += " ORDER BY id DESC"
        rows = conn.execute(sql, params).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/boards/<int:board_id>/captures")
    def create_capture(board_id):
        data = request.get_json(force=True) or {}
        raw = data.get("data") or ""
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[-1]
        try:
            blob = base64.b64decode(raw, validate=False) if raw else b""
        except (binascii.Error, ValueError):
            return jsonify({"error": "Invalid file data"}), 400

        orig_name = (data.get("orig_name") or "file").strip()
        mime = data.get("mime") or mimetypes.guess_type(orig_name)[0] or "application/octet-stream"
        node_id = data.get("node_id") or None
        folder_id = data.get("folder_id") or None

        conn = get_connection()
        cur = conn.execute(
            """INSERT INTO captures (board_id, node_id, folder_id, filename, orig_name, mime, size, caption, tags)
               VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)""",
            (board_id, node_id, folder_id, orig_name, mime, len(blob), data.get("caption", ""), data.get("tags", "")),
        )
        cap_id = cur.lastrowid
        ext = Path(orig_name).suffix or (mimetypes.guess_extension(mime) or "")
        filename = f"cap-{cap_id}-{_slug(Path(orig_name).stem)}{ext}"
        (db.captures_dir_for(board_id) / filename).write_bytes(blob)
        conn.execute("UPDATE captures SET filename = ? WHERE id = ?", (filename, cap_id))
        conn.commit()
        cap = conn.execute(
            "SELECT id, board_id, node_id, folder_id, orig_name, mime, size, caption, tags, created_at "
            "FROM captures WHERE id = ?", (cap_id,),
        ).fetchone()
        return jsonify(dict(cap)), 201

    @app.get("/api/captures/<int:capture_id>/file")
    def get_capture_file(capture_id):
        conn = get_connection()
        cap = conn.execute("SELECT * FROM captures WHERE id = ?", (capture_id,)).fetchone()
        if not cap:
            return jsonify({"error": "not found"}), 404
        path = db.captures_dir_for(cap["board_id"]) / cap["filename"]
        if not path.is_file():
            return jsonify({"error": "File missing on disk"}), 404
        return Response(path.read_bytes(), mimetype=cap["mime"] or "application/octet-stream")

    @app.get("/api/captures/<int:capture_id>/preview")
    def get_capture_preview(capture_id):
        """Server-side spreadsheet preview so .xlsx/.xls files can be shown
        as a real table right in the Vault modal instead of just a generic
        file icon - there's no way to render Excel's binary format in the
        browser itself."""
        conn = get_connection()
        cap = conn.execute("SELECT * FROM captures WHERE id = ?", (capture_id,)).fetchone()
        if not cap:
            return jsonify({"error": "not found"}), 404
        ext = Path(cap["orig_name"]).suffix.lower()
        if ext not in (".xlsx", ".xlsm"):
            return jsonify({"error": "No preview available for this file type"}), 400
        path = db.captures_dir_for(cap["board_id"]) / cap["filename"]
        if not path.is_file():
            return jsonify({"error": "File missing on disk"}), 404
        try:
            import openpyxl
            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        except Exception as exc:
            return jsonify({"error": f"Could not read spreadsheet: {exc}"}), 400
        MAX_ROWS, MAX_COLS = 300, 60
        sheets = []
        for ws in wb.worksheets:
            # iter_rows(max_col=...) always pads every row out to exactly
            # that many cells, even on a sheet with only 2 real columns -
            # clamp to the sheet's *actual* used range instead, so the
            # preview (and anything selected/copied out of it) doesn't
            # drag along dozens of empty trailing cells.
            real_rows = ws.max_row or 0
            real_cols = ws.max_column or 0
            use_rows = min(real_rows, MAX_ROWS)
            use_cols = min(real_cols, MAX_COLS)
            rows = []
            if use_rows and use_cols:
                for row in ws.iter_rows(max_row=use_rows, max_col=use_cols):
                    rows.append(["" if c.value is None else str(c.value) for c in row])
            sheets.append({
                "name": ws.title,
                "rows": rows,
                "truncated": real_rows > MAX_ROWS or real_cols > MAX_COLS,
            })
        wb.close()
        return jsonify({"sheets": sheets})

    @app.patch("/api/captures/<int:capture_id>")
    def update_capture(capture_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        fields = {k: data[k] for k in ("caption", "tags", "node_id", "folder_id") if k in data}
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE captures SET {set_clause} WHERE id = ?", (*fields.values(), capture_id))
            conn.commit()
        cap = conn.execute(
            "SELECT id, board_id, node_id, folder_id, orig_name, mime, size, caption, tags, created_at "
            "FROM captures WHERE id = ?", (capture_id,),
        ).fetchone()
        if not cap:
            return jsonify({"error": "not found"}), 404
        return jsonify(dict(cap))

    @app.post("/api/captures/<int:capture_id>/duplicate")
    def duplicate_capture(capture_id):
        conn = get_connection()
        cap = conn.execute("SELECT * FROM captures WHERE id = ?", (capture_id,)).fetchone()
        if not cap:
            return jsonify({"error": "not found"}), 404
        new_id = _duplicate_capture_file(conn, cap, cap["folder_id"], rename=True)
        conn.commit()
        row = conn.execute(
            "SELECT id, board_id, node_id, folder_id, orig_name, mime, size, caption, tags, created_at "
            "FROM captures WHERE id = ?", (new_id,),
        ).fetchone()
        return jsonify(dict(row)), 201

    @app.delete("/api/captures/<int:capture_id>")
    def delete_capture(capture_id):
        conn = get_connection()
        cap = conn.execute("SELECT * FROM captures WHERE id = ?", (capture_id,)).fetchone()
        if cap:
            path = db.captures_dir_for(cap["board_id"]) / cap["filename"]
            path.unlink(missing_ok=True)
            conn.execute("DELETE FROM captures WHERE id = ?", (capture_id,))
            conn.commit()
        return "", 204

    # ---------- credentials ----------

    def _cred_out(row):
        d = dict(row)
        d["has_secret"] = bool(d.pop("secret", ""))
        return d

    @app.get("/api/boards/<int:board_id>/creds")
    def list_creds(board_id):
        conn = get_connection()
        rows = conn.execute("SELECT * FROM creds WHERE board_id = ? ORDER BY id DESC", (board_id,)).fetchall()
        return jsonify([_cred_out(r) for r in rows])

    @app.post("/api/boards/<int:board_id>/creds")
    def create_cred(board_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        cur = conn.execute(
            """INSERT INTO creds (board_id, node_id, username, secret, kind, hash_type, service, status, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                board_id,
                data.get("node_id") or None,
                data.get("username", ""),
                crypto.encrypt(data.get("secret", "")),
                data.get("kind", "password"),
                data.get("hash_type", ""),
                data.get("service", ""),
                data.get("status", "untested"),
                data.get("notes", ""),
            ),
        )
        conn.commit()
        cred = conn.execute("SELECT * FROM creds WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(_cred_out(cred)), 201

    @app.patch("/api/creds/<int:cred_id>")
    def update_cred(cred_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        fields = {}
        for key in ("username", "kind", "hash_type", "service", "status", "notes", "node_id"):
            if key in data:
                fields[key] = data[key]
        if "secret" in data:
            fields["secret"] = crypto.encrypt(data["secret"])
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE creds SET {set_clause} WHERE id = ?", (*fields.values(), cred_id))
            conn.commit()
        cred = conn.execute("SELECT * FROM creds WHERE id = ?", (cred_id,)).fetchone()
        if not cred:
            return jsonify({"error": "not found"}), 404
        return jsonify(_cred_out(cred))

    @app.get("/api/creds/<int:cred_id>/reveal")
    def reveal_cred(cred_id):
        conn = get_connection()
        cred = conn.execute("SELECT secret FROM creds WHERE id = ?", (cred_id,)).fetchone()
        if not cred:
            return jsonify({"error": "not found"}), 404
        return jsonify({"secret": crypto.decrypt(cred["secret"])})

    @app.delete("/api/creds/<int:cred_id>")
    def delete_cred(cred_id):
        conn = get_connection()
        conn.execute("DELETE FROM creds WHERE id = ?", (cred_id,))
        conn.commit()
        return "", 204

    # ---------- findings ----------

    _SEVERITY_ORDER = "CASE severity WHEN 'crit' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 WHEN 'low' THEN 3 ELSE 4 END"

    @app.get("/api/boards/<int:board_id>/findings")
    def list_findings(board_id):
        conn = get_connection()
        rows = conn.execute(
            f"SELECT * FROM findings WHERE board_id = ? ORDER BY {_SEVERITY_ORDER}, id DESC", (board_id,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/boards/<int:board_id>/findings")
    def create_finding(board_id):
        data = request.get_json(force=True) or {}
        title = (data.get("title") or "Untitled").strip()
        conn = get_connection()
        cur = conn.execute(
            """INSERT INTO findings (board_id, node_id, title, description, impact, poc,
               remediation, refs, severity, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                board_id,
                data.get("node_id") or None,
                title,
                data.get("description", ""),
                data.get("impact", ""),
                data.get("poc", ""),
                data.get("remediation", ""),
                data.get("refs", ""),
                data.get("severity", "info"),
                data.get("status", "open"),
            ),
        )
        conn.commit()
        finding = conn.execute("SELECT * FROM findings WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(dict(finding)), 201

    @app.patch("/api/findings/<int:finding_id>")
    def update_finding(finding_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        fields = {}
        for key in ("node_id", "title", "description", "impact", "poc", "remediation",
                    "refs", "severity", "status"):
            if key in data:
                fields[key] = data[key]
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE findings SET {set_clause}, updated_at = datetime('now') WHERE id = ?",
                (*fields.values(), finding_id),
            )
            conn.commit()
        finding = conn.execute("SELECT * FROM findings WHERE id = ?", (finding_id,)).fetchone()
        if not finding:
            return jsonify({"error": "not found"}), 404
        return jsonify(dict(finding))

    @app.delete("/api/findings/<int:finding_id>")
    def delete_finding(finding_id):
        conn = get_connection()
        conn.execute("DELETE FROM findings WHERE id = ?", (finding_id,))
        conn.commit()
        return "", 204

    # ---------- reports (docs) ----------

    @app.get("/api/boards/<int:board_id>/docs")
    def list_docs(board_id):
        conn = get_connection()
        rows = conn.execute(
            "SELECT id, board_id, title, LENGTH(body) AS size, created_at, updated_at "
            "FROM docs WHERE board_id = ? ORDER BY updated_at DESC", (board_id,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/boards/<int:board_id>/docs")
    def create_doc(board_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        cur = conn.execute(
            "INSERT INTO docs (board_id, title, body) VALUES (?, ?, ?)",
            (board_id, (data.get("title") or "Report").strip(), data.get("body", "")),
        )
        conn.commit()
        doc = conn.execute("SELECT * FROM docs WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(dict(doc)), 201

    @app.get("/api/docs/<int:doc_id>")
    def get_doc(doc_id):
        conn = get_connection()
        doc = conn.execute("SELECT * FROM docs WHERE id = ?", (doc_id,)).fetchone()
        if not doc:
            return jsonify({"error": "not found"}), 404
        return jsonify(dict(doc))

    @app.patch("/api/docs/<int:doc_id>")
    def update_doc(doc_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        fields = {k: data[k] for k in ("title", "body") if k in data}
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE docs SET {set_clause}, updated_at = datetime('now') WHERE id = ?",
                (*fields.values(), doc_id),
            )
            conn.commit()
        doc = conn.execute("SELECT * FROM docs WHERE id = ?", (doc_id,)).fetchone()
        if not doc:
            return jsonify({"error": "not found"}), 404
        return jsonify(dict(doc))

    @app.delete("/api/docs/<int:doc_id>")
    def delete_doc(doc_id):
        conn = get_connection()
        conn.execute("DELETE FROM docs WHERE id = ?", (doc_id,))
        conn.commit()
        return "", 204

    @app.get("/api/docs/<int:doc_id>/export.md")
    def export_doc_md(doc_id):
        conn = get_connection()
        doc = conn.execute("SELECT * FROM docs WHERE id = ?", (doc_id,)).fetchone()
        if not doc:
            return jsonify({"error": "not found"}), 404
        body = (doc["body"] or "").encode("utf-8")
        return Response(
            body,
            mimetype="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{_slug(doc["title"])}.md"'},
        )

    # ---------- file: current location, open, save as, save ----------

    @app.get("/api/system/file-status")
    def file_status():
        cfg = load_config()
        return jsonify({
            "path": str(db.DB_PATH),
            "linked_path": cfg.get("linked_path"),
        })

    @app.post("/api/system/open")
    def open_database():
        """Switch the live working database to an existing (or new) file/folder."""
        data = request.get_json(force=True) or {}
        raw = (data.get("path") or "").strip()
        if not raw:
            return jsonify({"error": "Path not specified"}), 400

        target = Path(raw).expanduser()
        is_db_file = target.suffix.lower() == ".db"
        try:
            (target.parent if is_db_file else target).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return jsonify({"error": f"Could not open path: {exc}"}), 400

        existed = target.exists() if is_db_file else (target / "mapes.db").exists()

        db.configure(target)
        init_db()

        cfg = load_config()
        cfg["data_path"] = str(target)
        save_config(cfg)

        return jsonify({"path": str(db.DB_PATH), "existed": existed})

    @app.post("/api/system/save-as")
    def save_as():
        """Copy the current live database to a new file the user picks, and
        remember it so plain "Save" writes there again."""
        data = request.get_json(force=True) or {}
        raw = (data.get("path") or "").strip()
        if not raw:
            return jsonify({"error": "Path not specified"}), 400

        target = Path(raw).expanduser()
        if target.suffix.lower() != ".db":
            target = target.with_suffix(".db") if target.suffix else target / "mapes.db"

        try:
            db.backup_to(target)
        except OSError as exc:
            return jsonify({"error": f"Could not save: {exc}"}), 400

        cfg = load_config()
        cfg["linked_path"] = str(target)
        save_config(cfg)

        return jsonify({"path": str(target)})

    @app.post("/api/system/save")
    def save_now():
        """Re-save to the location previously chosen via "Save As"."""
        cfg = load_config()
        linked = cfg.get("linked_path")
        if not linked:
            return jsonify({"error": 'First pick a file via "Save As"'}), 400
        try:
            db.backup_to(linked)
        except OSError as exc:
            return jsonify({"error": f"Could not save: {exc}"}), 400
        return jsonify({"path": linked})

    # ---------- node badge counts (vault/creds/findings per node) ----------

    @app.get("/api/boards/<int:board_id>/node-counts")
    def node_counts(board_id):
        conn = get_connection()
        counts = {}

        def _tally(table):
            rows = conn.execute(
                f"SELECT node_id, COUNT(*) AS c FROM {table} "
                f"WHERE board_id = ? AND node_id IS NOT NULL GROUP BY node_id",
                (board_id,),
            ).fetchall()
            for r in rows:
                counts.setdefault(str(r["node_id"]), {"captures": 0, "creds": 0, "findings": 0})
                counts[str(r["node_id"])][table] = r["c"]

        _tally("captures")
        _tally("creds")
        _tally("findings")
        return jsonify(counts)

    # ---------- search ----------

    @app.get("/api/boards/<int:board_id>/search")
    def search_nodes(board_id):
        q = f"%{request.args.get('q', '')}%"
        conn = get_connection()
        rows = conn.execute(
            """SELECT * FROM nodes WHERE board_id = ?
               AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
               ORDER BY id""",
            (board_id, q, q, q),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get("/api/search")
    def search_everywhere():
        """Search across every board at once - nodes and reports - so
        something written weeks ago on a different board is still easy to
        find again, instead of only searching whichever board happens to be
        open right now."""
        term = (request.args.get("q") or "").strip()
        if not term:
            return jsonify({"nodes": [], "docs": []})
        q = f"%{term}%"
        conn = get_connection()
        node_rows = conn.execute(
            """SELECT nodes.*, boards.name AS board_name FROM nodes
               JOIN boards ON boards.id = nodes.board_id
               WHERE nodes.title LIKE ? OR nodes.content LIKE ? OR nodes.tags LIKE ?
               ORDER BY nodes.updated_at DESC LIMIT 50""",
            (q, q, q),
        ).fetchall()
        doc_rows = conn.execute(
            """SELECT docs.id, docs.board_id, docs.title, boards.name AS board_name FROM docs
               JOIN boards ON boards.id = docs.board_id
               WHERE docs.title LIKE ? OR docs.body LIKE ?
               ORDER BY docs.updated_at DESC LIMIT 50""",
            (q, q),
        ).fetchall()
        return jsonify({
            "nodes": [dict(r) for r in node_rows],
            "docs": [dict(r) for r in doc_rows],
        })

    return app
