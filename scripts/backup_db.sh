#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"

mkdir -p "${BACKUP_DIR}"

if [[ -n "${DATABASE_URL:-}" ]]; then
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "Error: pg_dump not found. Please install PostgreSQL client tools first." >&2
    exit 1
  fi

  OUTPUT_FILE="${BACKUP_DIR}/when2meet-postgres-${TIMESTAMP}.dump"
  pg_dump "${DATABASE_URL}" \
    --format=custom \
    --no-owner \
    --no-privileges \
    --file "${OUTPUT_FILE}"

  echo "Backup created: ${OUTPUT_FILE}"
  exit 0
fi

DB_PATH="${DATABASE_PATH:-${ROOT_DIR}/data/when2meet.db}"
if [[ ! -f "${DB_PATH}" ]]; then
  echo "Error: sqlite database not found: ${DB_PATH}" >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  OUTPUT_FILE="${BACKUP_DIR}/when2meet-sqlite-${TIMESTAMP}.sqlite3"
  sqlite3 "${DB_PATH}" ".backup '${OUTPUT_FILE}'"
else
  OUTPUT_FILE="${BACKUP_DIR}/when2meet-sqlite-${TIMESTAMP}.db"
  cp "${DB_PATH}" "${OUTPUT_FILE}"
fi

echo "Backup created: ${OUTPUT_FILE}"
