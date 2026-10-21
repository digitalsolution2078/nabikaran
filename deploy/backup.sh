#!/bin/sh
# Nightly database backup for Docker deployments. Runs as the `backup`
# service: every night at ~02:30 Nepal time it writes a gzipped pg_dump to
# $BACKUP_DIR (keeps the newest $KEEP_DAILY daily files and $KEEP_WEEKLY
# Sunday files). Deploys also back up before changing anything (deploy.sh).
set -u
: "${BACKUP_DIR:=/backups}"
: "${KEEP_DAILY:=14}"
: "${KEEP_WEEKLY:=8}"
: "${PGHOST:=db}"
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
echo "[backup] nightly backups to $BACKUP_DIR (keep $KEEP_DAILY daily, $KEEP_WEEKLY weekly)"
while true; do
  # Seconds until the next 02:30 Asia/Kathmandu (UTC+05:45 = 20:45 UTC the previous day).
  now=$(date -u +%s)
  target=$(date -u -d "$(date -u +%Y-%m-%d) 20:45:00" +%s 2>/dev/null || echo $((now + 86400)))
  [ "$target" -le "$now" ] && target=$((target + 86400))
  sleep $((target - now))
  stamp=$(date -u +%F)
  file="$BACKUP_DIR/daily/nabikaran-$stamp.sql.gz"
  if pg_dump -h "$PGHOST" -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$file.tmp" && gzip -t "$file.tmp" && [ "$(stat -c %s "$file.tmp")" -gt 1024 ]; then
    mv "$file.tmp" "$file"
    echo "[backup] ok $file $(stat -c %s "$file") bytes"
    [ "$(date -u +%u)" = "7" ] && cp "$file" "$BACKUP_DIR/weekly/"
  else
    rm -f "$file.tmp"
    echo "[backup] FAILED $stamp"
  fi
  ls -1t "$BACKUP_DIR/daily"/*.sql.gz 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f
  ls -1t "$BACKUP_DIR/weekly"/*.sql.gz 2>/dev/null | tail -n +$((KEEP_WEEKLY + 1)) | xargs -r rm -f
done
