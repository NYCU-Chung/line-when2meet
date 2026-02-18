import os
import sqlite3
from config import Config

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS groups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    line_group_id TEXT NOT NULL UNIQUE,
    name          TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    picture_url  TEXT,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    group_id     INTEGER NOT NULL,
    day_code     TEXT NOT NULL CHECK(day_code IN ('M','T','W','R','F','S','U')),
    slot_code    TEXT NOT NULL CHECK(slot_code IN ('y','z','1','2','3','4','n','5','6','7','8','9','a','b','c','d')),
    status       INTEGER NOT NULL DEFAULT 0 CHECK(status IN (0,1,2,3,4)),
    note         TEXT DEFAULT '',
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (line_user_id) REFERENCES users(line_user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    UNIQUE(line_user_id, group_id, day_code, slot_code)
);

CREATE INDEX IF NOT EXISTS idx_schedules_group ON schedules(group_id);
CREATE INDEX IF NOT EXISTS idx_schedules_user_group ON schedules(line_user_id, group_id);

-- 參與者：打開 LIFF/完成 auth 的使用者（用來讓統計的 total_users 更準確）
CREATE TABLE IF NOT EXISTS group_users (
    group_id     INTEGER NOT NULL,
    line_user_id TEXT NOT NULL,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, line_user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (line_user_id) REFERENCES users(line_user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_users_group ON group_users(group_id);
"""

DAY_CODES = ['M', 'T', 'W', 'R', 'F', 'S', 'U']
DAY_NAMES = {'M': '星期一', 'T': '星期二', 'W': '星期三', 'R': '星期四', 'F': '星期五', 'S': '星期六', 'U': '星期日'}
SLOT_CODES = ['y', 'z', '1', '2', '3', '4', 'n', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd']
SLOT_TIMES = {
    'y': '6:00~6:50',   'z': '7:00~7:50',
    '1': '8:00~8:50',   '2': '9:00~9:50',   '3': '10:10~11:00', '4': '11:10~12:00',
    'n': '12:20~13:10', '5': '13:20~14:10', '6': '14:20~15:10', '7': '15:30~16:20',
    '8': '16:30~17:20', '9': '17:30~18:20', 'a': '18:30~19:20', 'b': '19:30~20:20',
    'c': '20:30~21:20', 'd': '21:30~22:20',
}
STATUS_LABELS = {0: '有空', 1: '上課', 2: '忙碌', 3: '其他', 4: '睡覺'}


def get_db():
    db_path = Config.DATABASE_PATH
    # Increase timeout to reduce "database is locked" errors on sqlite under WSGI.
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _schedules_supports_sleep(conn):
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'"
    ).fetchone()
    if not row or not row["sql"]:
        return True
    sql = (row["sql"] or "").replace(" ", "")
    return "CHECK(statusIN(0,1,2,3,4))" in sql


def _migrate_schedules_add_sleep(conn):
    """
    SQLite 無法直接修改 CHECK constraint；用重建 table 的方式加入 status=4（睡覺）。
    """
    conn.execute("ALTER TABLE schedules RENAME TO schedules_old")
    conn.execute(
        """CREATE TABLE schedules (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            line_user_id TEXT NOT NULL,
            group_id     INTEGER NOT NULL,
            day_code     TEXT NOT NULL CHECK(day_code IN ('M','T','W','R','F','S','U')),
            slot_code    TEXT NOT NULL CHECK(slot_code IN ('y','z','1','2','3','4','n','5','6','7','8','9','a','b','c','d')),
            status       INTEGER NOT NULL DEFAULT 0 CHECK(status IN (0,1,2,3,4)),
            note         TEXT DEFAULT '',
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (line_user_id) REFERENCES users(line_user_id),
            FOREIGN KEY (group_id) REFERENCES groups(id),
            UNIQUE(line_user_id, group_id, day_code, slot_code)
        )"""
    )
    conn.execute(
        """INSERT INTO schedules (id, line_user_id, group_id, day_code, slot_code, status, note, updated_at)
           SELECT id, line_user_id, group_id, day_code, slot_code, status, note, updated_at
           FROM schedules_old"""
    )
    conn.execute("DROP TABLE schedules_old")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_schedules_group ON schedules(group_id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_schedules_user_group ON schedules(line_user_id, group_id)"
    )


def init_db():
    db_dir = os.path.dirname(Config.DATABASE_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = get_db()
    try:
        conn.executescript(SCHEMA_SQL)
        # Migration: allow status=4 (sleep) on existing DBs.
        if not _schedules_supports_sleep(conn):
            conn.execute("BEGIN")
            _migrate_schedules_add_sleep(conn)
        conn.commit()
    finally:
        conn.close()


def get_or_create_group(conn, line_group_id):
    """回傳 group 的 DB id，不存在就建立。"""
    row = conn.execute(
        "SELECT id FROM groups WHERE line_group_id = ?", (line_group_id,)
    ).fetchone()
    if row:
        return row["id"]
    cursor = conn.execute(
        "INSERT INTO groups (line_group_id) VALUES (?)", (line_group_id,)
    )
    conn.commit()
    return cursor.lastrowid


def upsert_user(conn, line_user_id, display_name, picture_url=None):
    conn.execute(
        """INSERT INTO users (line_user_id, display_name, picture_url, last_seen_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(line_user_id) DO UPDATE SET
               display_name = excluded.display_name,
               picture_url  = excluded.picture_url,
               last_seen_at = CURRENT_TIMESTAMP""",
        (line_user_id, display_name, picture_url),
    )
    conn.commit()


def upsert_group_user(conn, group_id, line_user_id):
    """
    記錄某使用者曾進入過該群組的排程頁（用於統計 total_users）。
    """
    conn.execute(
        """INSERT INTO group_users (group_id, line_user_id, last_seen_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(group_id, line_user_id) DO UPDATE SET
               last_seen_at = CURRENT_TIMESTAMP""",
        (group_id, line_user_id),
    )
    conn.commit()
