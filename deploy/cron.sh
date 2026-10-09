#!/bin/sh
# Worker scheduler for Docker deployments (replaces Vercel Cron).
# Dispatch every 60 s; reconcile every 300 s. Failures are logged, never fatal.
set -u
: "${APP_INTERNAL_URL:=http://app:3000}"
: "${WORKER_TOKEN:?WORKER_TOKEN required}"

tick=0
echo "[cron] starting against $APP_INTERNAL_URL"
# Give the app a moment to come up.
sleep 15
while true; do
  code=$(curl -sS -o /tmp/dispatch.out -w '%{http_code}' -X POST -H "Authorization: Bearer $WORKER_TOKEN" "$APP_INTERNAL_URL/api/jobs/dispatch" || echo "000")
  [ "$code" = "200" ] || echo "[cron] dispatch -> HTTP $code $(head -c 300 /tmp/dispatch.out 2>/dev/null)"
  if [ $((tick % 5)) -eq 0 ]; then
    code=$(curl -sS -o /tmp/reconcile.out -w '%{http_code}' -X POST -H "Authorization: Bearer $WORKER_TOKEN" "$APP_INTERNAL_URL/api/jobs/reconcile" || echo "000")
    [ "$code" = "200" ] || echo "[cron] reconcile -> HTTP $code $(head -c 300 /tmp/reconcile.out 2>/dev/null)"
  fi
  tick=$((tick + 1))
  sleep 60
done
