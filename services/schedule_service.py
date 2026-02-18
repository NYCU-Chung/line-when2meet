import logging
import time
from threading import Lock

import requests

from config import Config
from models.database import (
    DAY_CODES,
    SLOT_CODES,
    STATUS_LABELS,
    is_missing_table_error,
    upsert_user,
)


logger = logging.getLogger(__name__)
_line_profile_session = requests.Session()
_profile_sync_cache = {}
_profile_sync_lock = Lock()
PROFILE_SYNC_OK_TTL_SEC = 6 * 60 * 60
PROFILE_SYNC_FAIL_TTL_SEC = 15 * 60
PROFILE_SYNC_CACHE_MAX = 4096


def get_user_schedule(conn, line_user_id, group_id):
    """取得使用者在某群組的所有排程資料，回傳 dict {day-slot: {status, note}}。"""
    rows = conn.execute(
        "SELECT day_code, slot_code, status, note FROM schedules "
        "WHERE line_user_id = ? AND group_id = ?",
        (line_user_id, group_id),
    ).fetchall()
    result = {}
    for row in rows:
        key = f"{row['day_code']}-{row['slot_code']}"
        result[key] = {"status": row["status"], "note": row["note"]}
    return result


def save_user_schedule(conn, line_user_id, group_id, schedules):
    """
    批次儲存使用者排程。schedules 為 list of dict:
      [{"day": "M", "slot": "1", "status": 1, "note": "微積分"}, ...]

    規則（預設有空）：
    - status=0 代表有空（預設值）：不儲存，直接刪除記錄（回到預設）
    - status=1~5 代表非空閒（上課/忙碌/其他/睡覺/回家）：會儲存
    """
    for s in schedules:
        day = s.get("day")
        slot = s.get("slot")
        if day is None or slot is None:
            continue

        try:
            status = int(s.get("status"))
        except Exception:
            continue

        note = s.get("note", "")

        if day not in DAY_CODES or slot not in SLOT_CODES:
            continue

        if status == 0:
            # 有空 = 刪除記錄（還原預設）
            conn.execute(
                "DELETE FROM schedules WHERE line_user_id=? AND group_id=? AND day_code=? AND slot_code=?",
                (line_user_id, group_id, day, slot),
            )
        elif status in (1, 2, 3, 4, 5):
            conn.execute(
                """INSERT INTO schedules (line_user_id, group_id, day_code, slot_code, status, note, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(line_user_id, group_id, day_code, slot_code) DO UPDATE SET
                       status     = excluded.status,
                       note       = excluded.note,
                       updated_at = CURRENT_TIMESTAMP""",
                (line_user_id, group_id, day, slot, status, note),
            )
    # Commit should be controlled by the caller to reduce SQLite write-lock churn.


def _fetch_participant_rows(conn, group_id):
    # 有參與的使用者（以打開過 LIFF/auth 為準）；若 group_users 不存在則退回舊邏輯。
    try:
        user_rows = conn.execute(
            """SELECT gu.line_user_id, u.display_name, u.picture_url
               FROM group_users gu
               JOIN users u ON u.line_user_id = gu.line_user_id
               WHERE gu.group_id = ?
               ORDER BY gu.last_seen_at DESC""",
            (group_id,),
        ).fetchall()
    except Exception as e:
        if not is_missing_table_error(e):
            raise
        user_rows = conn.execute(
            """SELECT DISTINCT s.line_user_id, u.display_name, u.picture_url
               FROM schedules s
               JOIN users u ON u.line_user_id = s.line_user_id
               WHERE s.group_id = ?""",
            (group_id,),
        ).fetchall()
    else:
        # If group_users exists but is empty (old data), fall back to schedules.
        if not user_rows:
            user_rows = conn.execute(
                """SELECT DISTINCT s.line_user_id, u.display_name, u.picture_url
                   FROM schedules s
                   JOIN users u ON u.line_user_id = s.line_user_id
                   WHERE s.group_id = ?""",
                (group_id,),
            ).fetchall()
    return user_rows


def _get_group_line_id(conn, group_id):
    row = conn.execute("SELECT line_group_id FROM groups WHERE id = ?", (group_id,)).fetchone()
    return (row["line_group_id"] if row else "") or ""


def _should_sync_profile(group_line_id, line_user_id):
    if not group_line_id or not line_user_id:
        return False
    now = time.time()
    key = f"{group_line_id}:{line_user_id}"
    with _profile_sync_lock:
        item = _profile_sync_cache.get(key)
        if item and item[0] > now:
            return False
        _profile_sync_cache[key] = (now + PROFILE_SYNC_FAIL_TTL_SEC, False)
        if len(_profile_sync_cache) > PROFILE_SYNC_CACHE_MAX:
            # trim a small batch to avoid unbounded growth
            for k in list(_profile_sync_cache.keys())[:256]:
                if _profile_sync_cache[k][0] <= now:
                    _profile_sync_cache.pop(k, None)
            if len(_profile_sync_cache) > PROFILE_SYNC_CACHE_MAX:
                _profile_sync_cache.pop(next(iter(_profile_sync_cache)))
    return True


def _mark_profile_sync(group_line_id, line_user_id, ok):
    if not group_line_id or not line_user_id:
        return
    ttl = PROFILE_SYNC_OK_TTL_SEC if ok else PROFILE_SYNC_FAIL_TTL_SEC
    key = f"{group_line_id}:{line_user_id}"
    with _profile_sync_lock:
        _profile_sync_cache[key] = (time.time() + ttl, ok)


def _sync_missing_picture_urls(conn, group_id, user_rows):
    if not user_rows or not Config.LINE_CHANNEL_ACCESS_TOKEN:
        return False

    group_line_id = _get_group_line_id(conn, group_id)
    if not group_line_id:
        return False

    updated = False
    headers = {"Authorization": f"Bearer {Config.LINE_CHANNEL_ACCESS_TOKEN}"}

    for row in user_rows:
        line_user_id = (row["line_user_id"] or "").strip()
        if not line_user_id:
            continue
        if (row["picture_url"] or "").strip():
            continue
        if not _should_sync_profile(group_line_id, line_user_id):
            continue

        ok = False
        try:
            resp = _line_profile_session.get(
                f"https://api.line.me/v2/bot/group/{group_line_id}/member/{line_user_id}",
                headers=headers,
                timeout=(2, 4),
            )
        except requests.RequestException:
            _mark_profile_sync(group_line_id, line_user_id, False)
            continue

        if resp.status_code == 200:
            try:
                data = resp.json()
            except ValueError:
                _mark_profile_sync(group_line_id, line_user_id, False)
                continue

            display_name = (data.get("displayName") or row["display_name"] or line_user_id).strip()
            picture_url = (data.get("pictureUrl") or "").strip()
            upsert_user(conn, line_user_id, display_name, picture_url)
            updated = True
            ok = True
        elif resp.status_code in (403, 404):
            # User may have left the group or profile is unavailable for this bot.
            ok = False
        elif resp.status_code in (429,) or resp.status_code >= 500:
            logger.warning(
                "LINE profile fetch temporary failure group_id=%s user_id=%s status=%s",
                group_id,
                line_user_id,
                resp.status_code,
            )
            ok = False
        else:
            ok = False

        _mark_profile_sync(group_line_id, line_user_id, ok)

    if updated:
        conn.commit()
    return updated


def get_group_stats(conn, group_id):
    """
    取得群組統計資料。
    回傳:
      {
        "total_users": N,
        "slots": {
          "M-1": {
            "free_count": 5,
            "details": [
              {"user_id": "U...", "display_name": "小明", "status": 0, "note": ""},
              ...
            ]
          },
          ...
        }
      }
    """
    user_rows = _fetch_participant_rows(conn, group_id)
    try:
        if _sync_missing_picture_urls(conn, group_id, user_rows):
            user_rows = _fetch_participant_rows(conn, group_id)
    except Exception:
        # Avatar sync is best-effort; stats should still render.
        logger.exception("Failed to sync LINE profile pictures for group_id=%s", group_id)

    total_users = len(user_rows)
    users = [
        {
            "user_id": row["line_user_id"],
            "display_name": row["display_name"],
            "picture_url": row["picture_url"] or "",
        }
        for row in user_rows
    ]

    # 所有非空閒記錄（status=1~5）
    schedule_rows = conn.execute(
        """SELECT s.line_user_id, s.day_code, s.slot_code, s.status, s.note,
                  u.display_name, u.picture_url
           FROM schedules s
           JOIN users u ON u.line_user_id = s.line_user_id
           WHERE s.group_id = ?""",
        (group_id,),
    ).fetchall()

    # 建立 slot → details（只含非空閒的人）
    slots = {}
    for row in schedule_rows:
        key = f"{row['day_code']}-{row['slot_code']}"
        if key not in slots:
            slots[key] = {"details": []}
        slots[key]["details"].append(
            {
                "user_id": row["line_user_id"],
                "display_name": row["display_name"],
                "picture_url": row["picture_url"] or "",
                "status": row["status"],
                "status_label": STATUS_LABELS.get(row["status"], str(row["status"])),
                "note": row["note"],
            }
        )

    # 計算每個 slot 的 free_count（預設有空，所以 free = total - busy）
    for key in slots:
        busy_count = len(slots[key]["details"])
        slots[key]["free_count"] = max(0, total_users - busy_count)

    return {"total_users": total_users, "users": users, "slots": slots}
