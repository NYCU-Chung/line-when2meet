# Database Backup

This project includes an automated database backup workflow using GitHub Actions.

## 1. Configure GitHub secret

In your GitHub repo:

1. Open `Settings` -> `Secrets and variables` -> `Actions`.
2. Add a new repository secret:
   - Name: `DATABASE_URL`
   - Value: your Railway PostgreSQL URL

## 2. Automated schedule

Workflow file: `.github/workflows/db-backup.yml`

- Runs daily at `18:30 UTC` (Taipei `02:30`).
- Can also be triggered manually from `Actions` -> `Database Backup` -> `Run workflow`.
- Backup file is uploaded as an Actions artifact (retained for 30 days).

## 3. Local manual backup

Use:

```bash
bash scripts/backup_db.sh
```

- If `DATABASE_URL` is set, it uses `pg_dump`.
- Otherwise, it falls back to SQLite backup (`DATABASE_PATH`).

## 4. Restore PostgreSQL backup

```bash
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --dbname "$DATABASE_URL" \
  path/to/when2meet-postgres-YYYYmmddTHHMMSSZ.dump
```
