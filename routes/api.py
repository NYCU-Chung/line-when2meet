import requests
from flask import Blueprint, request, jsonify
from config import Config
from models.database import get_db, upsert_user
from services.schedule_service import get_user_schedule, save_user_schedule, get_group_stats

api_bp = Blueprint("api", __name__, url_prefix="/api")


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
    group_id = body.get("group_id")

    if not id_token or not group_id:
        return jsonify({"error": "id_token and group_id are required"}), 400

    try:
        user_id, display_name, picture_url = verify_liff_token(id_token)
    except Exception:
        return jsonify({"error": "invalid id_token"}), 401

    conn = get_db()
    try:
        upsert_user(conn, user_id, display_name, picture_url)
    finally:
        conn.close()

    return jsonify({"user_id": user_id, "display_name": display_name, "picture_url": picture_url})


# ── GET /api/schedule ──────────────────────────────────────────────────────────

@api_bp.route("/schedule", methods=["GET"])
def get_schedule():
    id_token = get_token_from_request()
    group_id = request.args.get("group_id", type=int)

    if not id_token or not group_id:
        return jsonify({"error": "Authorization header and group_id are required"}), 400

    try:
        user_id, display_name, picture_url = verify_liff_token(id_token)
    except Exception:
        return jsonify({"error": "invalid token"}), 401

    conn = get_db()
    try:
        upsert_user(conn, user_id, display_name, picture_url)
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
    group_id = body.get("group_id")
    schedules = body.get("schedules", [])

    if not group_id:
        return jsonify({"error": "group_id is required"}), 400

    try:
        user_id, display_name, picture_url = verify_liff_token(id_token)
    except Exception:
        return jsonify({"error": "invalid token"}), 401

    conn = get_db()
    try:
        upsert_user(conn, user_id, display_name, picture_url)
        save_user_schedule(conn, user_id, group_id, schedules)
    finally:
        conn.close()

    return jsonify({"success": True, "updated_count": len(schedules)})


# ── GET /api/stats ─────────────────────────────────────────────────────────────

@api_bp.route("/stats", methods=["GET"])
def stats():
    group_id = request.args.get("group_id", type=int)
    if not group_id:
        return jsonify({"error": "group_id is required"}), 400

    conn = get_db()
    try:
        data = get_group_stats(conn, group_id)
    finally:
        conn.close()

    return jsonify(data)
