import requests
import time
from threading import Lock
from flask import Blueprint, request, jsonify
from config import Config
from models.database import get_db, upsert_user, upsert_group_user, get_or_create_group
from services.schedule_service import get_user_schedule, save_user_schedule, get_group_stats

api_bp = Blueprint("api", __name__, url_prefix="/api")
_line_verify_session = requests.Session()
_verify_cache_lock = Lock()
_verify_cache = {}
VERIFY_CACHE_TTL_SEC = 300
VERIFY_CACHE_MAX_SIZE = 512


def _get_cached_verify_result(id_token):
    now = time.time()
    with _verify_cache_lock:
        item = _verify_cache.get(id_token)
        if not item:
            return None
        expires_at, payload = item
        if expires_at <= now:
            _verify_cache.pop(id_token, None)
            return None
        return payload


def _set_cached_verify_result(id_token, payload):
    now = time.time()
    with _verify_cache_lock:
        if len(_verify_cache) >= VERIFY_CACHE_MAX_SIZE:
            expired = [k for k, (exp, _) in _verify_cache.items() if exp <= now]
            for k in expired[:128]:
                _verify_cache.pop(k, None)
            if len(_verify_cache) >= VERIFY_CACHE_MAX_SIZE:
                _verify_cache.pop(next(iter(_verify_cache)))
        _verify_cache[id_token] = (now + VERIFY_CACHE_TTL_SEC, payload)

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
    cached = _get_cached_verify_result(id_token)
    if cached:
        return cached

    resp = _line_verify_session.post(
        "https://api.line.me/oauth2/v2.1/verify",
        data={
            "id_token": id_token,
            "client_id": Config.LIFF_ID_SCHEDULE.split("-")[0],
        },
        timeout=(2, 4),
    )
    if resp.status_code != 200:
        raise ValueError("invalid token")
    data = resp.json()
    sub = data.get("sub")
    if not sub:
        raise ValueError("invalid token")

    result = (sub, data.get("name", ""), data.get("picture", ""))
    _set_cached_verify_result(id_token, result)
    return result


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
