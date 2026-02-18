import os
import sqlite3
from config import Config

try:
    import psycopg
    from psycopg import errors as pg_errors
    from psycopg.rows import dict_row
except Exception:  # pragma: no cover - fallback when psycopg isn't installed locally
    psycopg = None
    pg_errors = None
    dict_row = None


DB_BACKEND = "postgres" if (Config.DATABASE_URL or "").strip() else "sqlite"

SQLITE_SCHEMA_SQL = """
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
    slot_code    TEXT NOT NULL CHECK(slot_code IN ('y','z','1','2','3','4','n','5','6','7','8','9','a','b','c','d','e','f')),
    status       INTEGER NOT NULL DEFAULT 0 CHECK(status IN (0,1,2,3,4,5)),
    note         TEXT DEFAULT '',
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (line_user_id) REFERENCES users(line_user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    UNIQUE(line_user_id, group_id, day_code, slot_code)
);

CREATE INDEX IF NOT EXISTS idx_schedules_group ON schedules(group_id);
CREATE INDEX IF NOT EXISTS idx_schedules_user_group ON schedules(line_user_id, group_id);

CREATE TABLE IF NOT EXISTS group_users (
    group_id      INTEGER NOT NULL,
    line_user_id  TEXT NOT NULL,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, line_user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (line_user_id) REFERENCES users(line_user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_users_group ON group_users(group_id);
"""

POSTGRES_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS groups (
    id            BIGSERIAL PRIMARY KEY,
    line_group_id TEXT NOT NULL UNIQUE,
    name          TEXT,
    created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id           BIGSERIAL PRIMARY KEY,
    line_user_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    picture_url  TEXT,
    last_seen_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedules (
    id           BIGSERIAL PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES users(line_user_id),
    group_id     BIGINT NOT NULL REFERENCES groups(id),
    day_code     TEXT NOT NULL CHECK(day_code IN ('M','T','W','R','F','S','U')),
    slot_code    TEXT NOT NULL CHECK(slot_code IN ('y','z','1','2','3','4','n','5','6','7','8','9','a','b','c','d','e','f')),
    status       INTEGER NOT NULL DEFAULT 0 CHECK(status IN (0,1,2,3,4,5)),
    note         TEXT DEFAULT '',
    updated_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(line_user_id, group_id, day_code, slot_code)
);

CREATE INDEX IF NOT EXISTS idx_schedules_group ON schedules(group_id);
CREATE INDEX IF NOT EXISTS idx_schedules_user_group ON schedules(line_user_id, group_id);

CREATE TABLE IF NOT EXISTS group_users (
    group_id      BIGINT NOT NULL REFERENCES groups(id),
    line_user_id  TEXT NOT NULL REFERENCES users(line_user_id),
    first_seen_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, line_user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_users_group ON group_users(group_id);
"""

DAY_CODES = ["M", "T", "W", "R", "F", "S", "U"]
DAY_NAMES = {"M": "星期一", "T": "星期二", "W": "星期三", "R": "星期四", "F": "星期五", "S": "星期六", "U": "星期日"}
SLOT_CODES = ["y", "z", "1", "2", "3", "4", "n", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]
SLOT_TIMES = {
    "y": "6:00~6:50", "z": "7:00~7:50",
    "1": "8:00~8:50", "2": "9:00~9:50", "3": "10:10~11:00", "4": "11:10~12:00",
    "n": "12:20~13:10", "5": "13:20~14:10", "6": "14:20~15:10", "7": "15:30~16:20",
    "8": "16:30~17:20", "9": "17:30~18:20", "a": "18:30~19:20", "b": "19:30~20:20",
    "c": "20:30~21:20", "d": "21:30~22:20", "e": "22:30~23:20", "f": "23:30~24:00",
}
STATUS_LABELS = {0: "有空", 1: "上課", 2: "忙碌", 3: "其他", 4: "睡覺", 5: "回家"}


def is_postgres():
    return DB_BACKEND == "postgres"


def is_missing_table_error(exc):
    if isinstance(exc, sqlite3.OperationalError):
        return "no such table" in str(exc).lower()
    if pg_errors and isinstance(exc, pg_errors.UndefinedTable):
        return True
    sqlstate = getattr(exc, "sqlstate", None)
    return sqlstate == "42P01"


def _convert_qmark_placeholders(query):
    # Current SQL only uses "?" as placeholders. Convert for psycopg (%s style).
    return query.replace("?", "%s")


def _split_sql_statements(script):
    return [stmt.strip() for stmt in script.split(";") if stmt.strip()]


class DBConnection:
    """
    Thin wrapper to keep one query style (`?`) for both sqlite and postgres.
    """

    def __init__(self, conn, backend):
        self._conn = conn
        self.backend = backend

    def _adapt_query(self, query):
        if self.backend != "postgres":
            return query
        stripped = query.lstrip().upper()
        if stripped.startswith("BEGIN IMMEDIATE"):
            return "BEGIN"
        return _convert_qmark_placeholders(query)

    def execute(self, query, params=()):
        if params is None:
            params = ()
        return self._conn.execute(self._adapt_query(query), params)

    def executescript(self, script):
        if self.backend == "sqlite":
            return self._conn.executescript(script)
        for stmt in _split_sql_statements(script):
            self._conn.execute(stmt)

    def commit(self):
        return self._conn.commit()

    def rollback(self):
        return self._conn.rollback()

    def close(self):
        return self._conn.close()

    def __getattr__(self, item):
        return getattr(self._conn, item)


def _sqlite_schedules_supports_current_schema(conn):
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'"
    ).fetchone()
    if not row or not row["sql"]:
        return True
    sql = (row["sql"] or "").replace(" ", "")
    has_status_check = "CHECK(statusIN(0,1,2,3,4,5))" in sql
    has_slot_e = "'e'" in sql
    has_slot_f = "'f'" in sql
    return has_status_check and has_slot_e and has_slot_f


def _sqlite_migrate_schedules_to_current_schema(conn):
    conn.execute("ALTER TABLE schedules RENAME TO schedules_old")
    conn.execute(
        """CREATE TABLE schedules (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            line_user_id TEXT NOT NULL,
            group_id     INTEGER NOT NULL,
            day_code     TEXT NOT NULL CHECK(day_code IN ('M','T','W','R','F','S','U')),
            slot_code    TEXT NOT NULL CHECK(slot_code IN ('y','z','1','2','3','4','n','5','6','7','8','9','a','b','c','d','e','f')),
            status       INTEGER NOT NULL DEFAULT 0 CHECK(status IN (0,1,2,3,4,5)),
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


def get_db():
    if is_postgres():
        if psycopg is None:
            raise RuntimeError("psycopg is required when DATABASE_URL is set")
        raw = psycopg.connect(
            Config.DATABASE_URL,
            autocommit=False,
            row_factory=dict_row,
        )
        return DBConnection(raw, "postgres")

    db_path = Config.DATABASE_PATH
    raw = sqlite3.connect(db_path, timeout=10)
    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA journal_mode=WAL")
    raw.execute("PRAGMA foreign_keys=ON")
    raw.execute("PRAGMA busy_timeout=5000")
    return DBConnection(raw, "sqlite")


def init_db():
    if not is_postgres():
        db_dir = os.path.dirname(Config.DATABASE_PATH)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)

    conn = get_db()
    try:
        schema_sql = POSTGRES_SCHEMA_SQL if is_postgres() else SQLITE_SCHEMA_SQL
        conn.executescript(schema_sql)

        if not is_postgres() and not _sqlite_schedules_supports_current_schema(conn):
            conn.execute("BEGIN")
            _sqlite_migrate_schedules_to_current_schema(conn)

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

    conn.execute(
        """INSERT INTO groups (line_group_id)
           VALUES (?)
           ON CONFLICT(line_group_id) DO NOTHING""",
        (line_group_id,),
    )
    conn.commit()
    row = conn.execute(
        "SELECT id FROM groups WHERE line_group_id = ?", (line_group_id,)
    ).fetchone()
    return row["id"]


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
    # Commit should be controlled by the caller to reduce write-lock churn.


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
    # Commit should be controlled by the caller to reduce write-lock churn.
