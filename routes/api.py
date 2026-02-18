import requests
from flask import Blueprint, request, jsonify
from config import Config
from models.database import get_db, upsert_user, upsert_group_user, get_or_create_group
from services.schedule_service import get_user_schedule, save_user_schedule, get_group_stats

api_bp = Blueprint("api", __name__, url_prefix="/api")

def resolve_group_id(conn, group_value):
    """
    Accept both legacy numeric group_id (DB id) and stable LINE groupId (string).
    Returns int group_id or None.
    """
    if group_value is None:
        return None
    gv = str(group_value).strip()
    if not gv:
        return None

    if gv.isdigit():
        gid = int(gv)
        row = conn.execute("SELECT 1 FROM groups WHERE id = ?", (gid,)).fetchone()
        return gid if row else None

    # Treat as LINE groupId
    return get_or_create_group(conn, gv)


def verify_liff_token(id_token):
    """驗證 LIFF ID Token，回傳 (line_user_id, display_name, picture_url) 或 raise ValueError。"""
    resp = requests.post(
        "https://api.line.me/oauth2/v2.1/verify",
        data={
            "id_token": id_token,
            "client_id": Config.LIFF_ID_SCHEDULE.split("-")[0],
        },
        timeout=5,
    )
    if resp.status_code != 200:
        raise ValueError("invalid token")
    data = resp.json()
    return data.get("sub"), data.get("name", ""), data.get("picture", "")


def get_token_from_request():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


# ── POST /api/auth ─────────────────────────────────────────────────────────────

@api_bp.route("/auth", methods=["POST"])
def auth():
    body = request.get_json(silent=True) or {}
    id_token = body.get("id_token")
    group_value = body.get("group") or body.get("group_id")

    if not id_token or not group_value:
        return jsonify({"error": "id_token and group are required"}), 400

    conn = get_db()
    try:
        group_id = resolve_group_id(conn, group_value)
        if not group_id:
            return jsonify({"error": "group not found (link expired). Please trigger the bot again in the group."}), 410

        try:
            user_id, display_name, picture_url = verify_liff_token(id_token)
        except Exception:
            return jsonify({"error": "invalid id_token"}), 401

        upsert_user(conn, user_id, display_name, picture_url)
        upsert_group_user(conn, int(group_id), user_id)
        conn.commit()
    finally:
        conn.close()

    return jsonify({"user_id": user_id, "display_name": display_name, "picture_url": picture_url})


# ── GET /api/schedule ──────────────────────────────────────────────────────────

@api_bp.route("/schedule", methods=["GET"])
def get_schedule():
    id_token = get_token_from_request()
    group_value = request.args.get("group") or request.args.get("group_id")

    if not id_token or not group_value:
        return jsonify({"error": "Authorization header and group are required"}), 400

    conn = get_db()
    try:
        group_id = resolve_group_id(conn, group_value)
        if not group_id:
            return jsonify({"error": "group not found (link expired). Please trigger the bot again in the group."}), 410

        try:
            user_id, display_name, picture_url = verify_liff_token(id_token)
        except Exception:
            return jsonify({"error": "invalid token"}), 401

        upsert_user(conn, user_id, display_name, picture_url)
        upsert_group_user(conn, int(group_id), user_id)
        conn.commit()
        schedule = get_user_schedule(conn, user_id, group_id)
    finally:
        conn.close()

    return jsonify({"schedules": schedule})


# ── POST /api/schedule ─────────────────────────────────────────────────────────

@api_bp.route("/schedule", methods=["POST"])
def post_schedule():
    id_token = get_token_from_request()
    if not id_token:
        return jsonify({"error": "Authorization header required"}), 400

    body = request.get_json(silent=True) or {}
    group_value = body.get("group") or body.get("group_id")
    schedules = body.get("schedules", [])

    if not group_value:
        return jsonify({"error": "group is required"}), 400

    conn = get_db()
    try:
        group_id = resolve_group_id(conn, group_value)
        if not group_id:
            return jsonify({"error": "group not found (link expired). Please trigger the bot again in the group."}), 410

        try:
            user_id, display_name, picture_url = verify_liff_token(id_token)
        except Exception:
            return jsonify({"error": "invalid token"}), 401

        # Single transaction to reduce sqlite lock probability.
        try:
            conn.execute("BEGIN IMMEDIATE")
            upsert_user(conn, user_id, display_name, picture_url)
            upsert_group_user(conn, int(group_id), user_id)
            save_user_schedule(conn, user_id, group_id, schedules)
            conn.commit()
        except Exception as e:
            # Return a short error for UI debugging; detailed stack is in logs.
            try:
                conn.rollback()
            except Exception:
                pass
            return jsonify({"error": "save failed", "detail": str(e)}), 500
    finally:
        conn.close()

    return jsonify({"success": True, "updated_count": len(schedules)})


# ── GET /api/stats ─────────────────────────────────────────────────────────────

@api_bp.route("/stats", methods=["GET"])
def stats():
    conn = get_db()
    try:
        group_value = request.args.get("group") or request.args.get("group_id")
        if not group_value:
            return jsonify({"error": "group is required"}), 400

        group_id = resolve_group_id(conn, group_value)
        if not group_id:
            return jsonify({"error": "group not found (link expired). Please trigger the bot again in the group."}), 410

        data = get_group_stats(conn, group_id)
    finally:
        conn.close()

    return jsonify(data)
