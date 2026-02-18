import sqlite3
from models.database import DAY_CODES, SLOT_CODES, STATUS_LABELS


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
    # 有參與的使用者（以打開過 LIFF/auth 為準）；若舊 DB 尚未有 group_users table，退回舊邏輯。
    try:
        user_rows = conn.execute(
            """SELECT gu.line_user_id, u.display_name, u.picture_url
               FROM group_users gu
               JOIN users u ON u.line_user_id = gu.line_user_id
               WHERE gu.group_id = ?
               ORDER BY gu.last_seen_at DESC""",
            (group_id,),
        ).fetchall()
    except sqlite3.OperationalError:
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

    total_users = len(user_rows)

    # 所有非空閒記錄（status=1~5）
    schedule_rows = conn.execute(
        """SELECT s.line_user_id, s.day_code, s.slot_code, s.status, s.note,
                  u.display_name
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
                "status": row["status"],
                "status_label": STATUS_LABELS.get(row["status"], str(row["status"])),
                "note": row["note"],
            }
        )

    # 計算每個 slot 的 free_count（預設有空，所以 free = total - busy）
    for key in slots:
        busy_count = len(slots[key]["details"])
        slots[key]["free_count"] = max(0, total_users - busy_count)

    return {"total_users": total_users, "slots": slots}
