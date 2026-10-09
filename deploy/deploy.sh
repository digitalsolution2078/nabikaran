#!/usr/bin/env bash
# Nabikaran production deploy (run on the VPS; GitHub Actions calls it over SSH).
#
#   deploy/deploy.sh [commit-sha]      default: latest origin/main
#
# Steps: lock → refuse local changes → fetch → verify the commit is on main →
# back up the database → check out → build → up (migrations run in the
# `migrate` container; the app starts only if they succeed) → health check.
# If the build, migrations or health check fail, the previous commit is
# rebuilt and started again, and the script exits non-zero.
#
# Migrations are additive and are NOT rolled back automatically. If you must
# restore data, use the backup this run printed (see docs/DEPLOY_VPS.md §7).
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

COMPOSE=(docker compose --env-file .env.production)
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/nabikaran}"
KEEP_BACKUPS="${KEEP_BACKUPS:-14}"
HEALTH_TRIES="${HEALTH_TRIES:-45}"   # × 2 s
TARGET="${1:-}"

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# One deploy at a time.
exec 9>"${TMPDIR:-/tmp}/nabikaran-deploy.lock"
flock -n 9 || die "another deploy is already running"

[[ -f .env.production ]] || die ".env.production not found in $APP_DIR"
if [[ -n "$TARGET" && ! "$TARGET" =~ ^[0-9a-f]{7,40}$ ]]; then die "invalid commit id: $TARGET"; fi

# Never overwrite work done by hand on the server.
git update-index -q --refresh
git diff-index --quiet HEAD -- || die "uncommitted changes to tracked files on the server; commit or discard them first"

PREV="$(git rev-parse HEAD)"
git fetch --quiet origin main
if [[ -n "$(git rev-list origin/main..HEAD 2>/dev/null)" ]]; then die "server has commits that are not on origin/main; resolve manually"; fi
NEW="$(git rev-parse --verify --quiet "${TARGET:-origin/main}^{commit}")" || die "commit ${TARGET} not found on origin/main"
git merge-base --is-ancestor "$NEW" origin/main || die "commit $NEW is not on origin/main; refusing to deploy"

if [[ "$NEW" == "$PREV" && "${FORCE:-0}" != "1" ]]; then
  log "already at ${NEW:0:7}; nothing to do (FORCE=1 to rebuild anyway)"
  exit 0
fi
log "deploying ${PREV:0:7} → ${NEW:0:7}"
git --no-pager log --oneline "$PREV..$NEW" | head -20 || true

# 1. Backup (skipped only when the database container is not running yet, e.g. first install).
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP=""
if [[ -n "$("${COMPOSE[@]}" ps -q db 2>/dev/null)" ]]; then
  BACKUP="$BACKUP_DIR/nabikaran-$(date -u +%Y%m%d-%H%M%S)-${PREV:0:7}.sql.gz"
  log "backing up database → $BACKUP"
  "${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$BACKUP"
  gzip -t "$BACKUP" || die "backup is not a valid gzip file"
  [[ "$(stat -c %s "$BACKUP")" -gt 1024 ]] || die "backup is suspiciously small; aborting before any change"
  chmod 600 "$BACKUP"
  # keep the newest $KEEP_BACKUPS backups
  ls -1t "$BACKUP_DIR"/nabikaran-*.sql.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
else
  log "database container not running; skipping backup"
fi

healthy() {
  "${COMPOSE[@]}" exec -T app node -e '
    fetch("http://127.0.0.1:3000/api/health")
      .then(async (r) => { const j = await r.json(); process.exit(r.ok && j.db === "ok" ? 0 : 1); })
      .catch(() => process.exit(1));' >/dev/null 2>&1
}

wait_healthy() {
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if healthy; then return 0; fi
    sleep 2
  done
  return 1
}

switch_to() { git checkout -q -B main "$1"; git branch -q --set-upstream-to=origin/main main 2>/dev/null || true; }

rollback() {
  local why="$1"
  log "FAILED: $why — rolling back to ${PREV:0:7}"
  "${COMPOSE[@]}" logs --tail=60 migrate app 2>/dev/null || true
  switch_to "$PREV"
  if "${COMPOSE[@]}" up -d --build && wait_healthy; then
    log "rolled back; ${PREV:0:7} is running again"
  else
    log "ROLLBACK ALSO FAILED — check 'docker compose logs app' now"
  fi
  [[ -n "$BACKUP" ]] && log "pre-deploy backup: $BACKUP"
  exit 1
}

# 2. Check out and build while the old version keeps serving.
switch_to "$NEW"
log "building image"
"${COMPOSE[@]}" build app || rollback "image build failed"

# 3. Start: migrate runs first; app and cron start only if migrations succeed.
log "starting containers (migrations run first)"
"${COMPOSE[@]}" up -d || rollback "docker compose up failed (see migrate logs)"
"${COMPOSE[@]}" logs --tail=20 migrate || true

# 4. Health check inside the app container (works with or without a published port).
log "waiting for /api/health"
wait_healthy || rollback "health check did not pass within $((HEALTH_TRIES * 2)) s"

docker image prune -f >/dev/null 2>&1 || true
log "deployed ${NEW:0:7} successfully"
printf '%s %s -> %s ok %s\n' "$(date -u +%FT%TZ)" "${PREV:0:7}" "${NEW:0:7}" "${BACKUP:-no-backup}" >> "$BACKUP_DIR/deploys.log"
