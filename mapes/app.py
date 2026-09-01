from pathlib import Path

from flask import Flask, jsonify, request, render_template

from . import db
from .config import load_config, save_config
from .db import get_connection, init_db
from .paths import resource_root


def create_app():
    root = resource_root()
    app = Flask(
        __name__,
        template_folder=str(root / "templates"),
        static_folder=str(root / "static"),
    )
    init_db()

    # ---------- boards ----------

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/boards")
    def list_boards():
        conn = get_connection()
        rows = conn.execute("SELECT * FROM boards ORDER BY id").fetchall()
        conn.close()
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
        conn.close()
        return jsonify(dict(board)), 201

    @app.put("/api/boards/<int:board_id>")
    def update_board(board_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        board = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
        if not board:
            conn.close()
            return jsonify({"error": "not found"}), 404
        name = data.get("name", board["name"])
        description = data.get("description", board["description"])
        conn.execute(
            "UPDATE boards SET name = ?, description = ? WHERE id = ?",
            (name, description, board_id),
        )
        conn.commit()
        board = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
        conn.close()
        return jsonify(dict(board))

    @app.delete("/api/boards/<int:board_id>")
    def delete_board(board_id):
        conn = get_connection()
        conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))
        conn.commit()
        conn.close()
        return "", 204

    # ---------- nodes ----------

    @app.get("/api/boards/<int:board_id>/nodes")
    def list_nodes(board_id):
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM nodes WHERE board_id = ? ORDER BY id", (board_id,)
        ).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/boards/<int:board_id>/nodes")
    def create_node(board_id):
        data = request.get_json(force=True) or {}
        title = (data.get("title") or "Без названия").strip()
        conn = get_connection()
        cur = conn.execute(
            """INSERT INTO nodes (board_id, type, title, content, tags, color, x, y)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                board_id,
                data.get("type", "note"),
                title,
                data.get("content", ""),
                data.get("tags", ""),
                data.get("color", "#4f8cff"),
                data.get("x", 40),
                data.get("y", 40),
            ),
        )
        conn.commit()
        node = conn.execute("SELECT * FROM nodes WHERE id = ?", (cur.lastrowid,)).fetchone()
        conn.close()
        return jsonify(dict(node)), 201

    @app.put("/api/nodes/<int:node_id>")
    def update_node(node_id):
        data = request.get_json(force=True) or {}
        conn = get_connection()
        node = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if not node:
            conn.close()
            return jsonify({"error": "not found"}), 404
        fields = {}
        for key in ("type", "title", "content", "tags", "color", "x", "y"):
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
        conn.close()
        return jsonify(dict(node))

    @app.delete("/api/nodes/<int:node_id>")
    def delete_node(node_id):
        conn = get_connection()
        conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        conn.commit()
        conn.close()
        return "", 204

    # ---------- edges ----------

    @app.get("/api/boards/<int:board_id>/edges")
    def list_edges(board_id):
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM edges WHERE board_id = ? ORDER BY id", (board_id,)
        ).fetchall()
        conn.close()
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
        conn.close()
        return jsonify(dict(edge)), 201

    @app.delete("/api/edges/<int:edge_id>")
    def delete_edge(edge_id):
        conn = get_connection()
        conn.execute("DELETE FROM edges WHERE id = ?", (edge_id,))
        conn.commit()
        conn.close()
        return "", 204

    # ---------- data location (open/switch database) ----------

    @app.get("/api/system/data-location")
    def get_data_location():
        return jsonify({
            "path": str(db.DB_PATH),
            "dir": str(db.DATA_DIR),
            "exists": db.DB_PATH.exists(),
        })

    @app.post("/api/system/data-location")
    def set_data_location():
        data = request.get_json(force=True) or {}
        raw = (data.get("path") or "").strip()
        if not raw:
            return jsonify({"error": "Путь не указан"}), 400

        target = Path(raw).expanduser()
        is_db_file = target.suffix.lower() == ".db"
        try:
            (target.parent if is_db_file else target).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return jsonify({"error": f"Не удалось открыть путь: {exc}"}), 400

        existed = target.exists() if is_db_file else (target / "mapes.db").exists()

        db.configure(target)
        init_db()

        cfg = load_config()
        cfg["data_path"] = str(target)
        save_config(cfg)

        return jsonify({
            "path": str(db.DB_PATH),
            "dir": str(db.DATA_DIR),
            "existed": existed,
        })

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
        conn.close()
        return jsonify([dict(r) for r in rows])

    return app
