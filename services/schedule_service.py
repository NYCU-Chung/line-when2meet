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

    status=-1 代表「未選取/清除」：刪除記錄。
    status=0~3 代表使用者明確選取的狀態：都會儲存（包含 status=0 有空）。
    """
    for s in schedules:
        day = s["day"]
        slot = s["slot"]
        status = int(s["status"])
        note = s.get("note", "")

        if day not in DAY_CODES or slot not in SLOT_CODES:
            continue

        if status == -1:
            # 未選取/清除
            conn.execute(
                "DELETE FROM schedules WHERE line_user_id=? AND group_id=? AND day_code=? AND slot_code=?",
                (line_user_id, group_id, day, slot),
            )
        elif status in (0, 1, 2, 3):
            conn.execute(
                """INSERT INTO schedules (line_user_id, group_id, day_code, slot_code, status, note, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(line_user_id, group_id, day_code, slot_code) DO UPDATE SET
                       status     = excluded.status,
                       note       = excluded.note,
                       updated_at = CURRENT_TIMESTAMP""",
                (line_user_id, group_id, day, slot, status, note),
            )
    conn.commit()


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
    # 有填寫過的使用者
    user_rows = conn.execute(
        """SELECT DISTINCT s.line_user_id, u.display_name, u.picture_url
           FROM schedules s
           JOIN users u ON u.line_user_id = s.line_user_id
           WHERE s.group_id = ?""",
        (group_id,),
    ).fetchall()

    total_users = len(user_rows)
    user_map = {r["line_user_id"]: {"display_name": r["display_name"], "picture_url": r["picture_url"]} for r in user_rows}

    # 所有記錄（包含有空）
    schedule_rows = conn.execute(
        """SELECT s.line_user_id, s.day_code, s.slot_code, s.status, s.note,
                  u.display_name
           FROM schedules s
           JOIN users u ON u.line_user_id = s.line_user_id
           WHERE s.group_id = ?""",
        (group_id,),
    ).fetchall()

    # 建立 slot → details 的 mapping（含所有已選取的人）
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
                "status_label": STATUS_LABELS[row["status"]],
                "note": row["note"],
            }
        )

    # 計算每個 slot 的 free_count（status=0）
    for key in slots:
        free_count = sum(1 for d in slots[key]["details"] if d["status"] == 0)
        slots[key]["free_count"] = free_count
        slots[key]["known_count"] = len(slots[key]["details"])
        slots[key]["unknown_count"] = max(0, total_users - slots[key]["known_count"])

    return {"total_users": total_users, "slots": slots}
