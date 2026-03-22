# Database Backup

This project includes an automated database backup workflow using GitHub Actions.

## 1. Configure GitHub secret

In your GitHub repo:

1. Open `Settings` -> `Secrets and variables` -> `Actions`.
2. Add a new repository secret:
   - Name: `DATABASE_URL`
   - Value: `postgresql://when2meet:<DB_PASSWORD>@<ORACLE_CLOUD_PUBLIC_IP>:5432/when2meet`
     - Replace `<DB_PASSWORD>` with the value from your `.env`
     - Replace `<ORACLE_CLOUD_PUBLIC_IP>` with your VM's public IP
     - **Note:** Port 5432 must be open in Oracle Cloud Security List and OS firewall for remote backups.
     - Alternatively, run backups directly on the VM (see §3).

## 2. Automated schedule

Workflow file: `.github/workflows/db-backup.yml`

- Runs daily at `18:30 UTC` (Taipei `02:30`).
- Can also be triggered manually from `Actions` -> `Database Backup` -> `Run workflow`.
- Backup file is uploaded as an Actions artifact (retained for 30 days).

## 3. Local / on-VM manual backup

SSH into the Oracle Cloud VM and run:

```bash
cd ~/line-when2meet

# Backup from the running PostgreSQL container
docker compose exec db pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  postgresql://when2meet:<DB_PASSWORD>@localhost:5432/when2meet \
  > backups/when2meet-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Or use the backup script (requires `DATABASE_URL` to be set):

```bash
bash scripts/backup_db.sh
```

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

## 5. Migrate from Railway

To export data from Railway before shutting it down:

```bash
# On your local machine (requires Railway CLI and psql client)
railway run pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file railway-export.dump

# Then restore to Oracle Cloud VM
scp railway-export.dump ubuntu@<ORACLE_IP>:~/line-when2meet/backups/

# On the VM
docker compose exec -T db pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  --dbname postgresql://when2meet:<DB_PASSWORD>@localhost:5432/when2meet \
  < backups/railway-export.dump
```
