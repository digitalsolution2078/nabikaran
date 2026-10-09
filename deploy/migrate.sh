#!/bin/sh
# Applies supabase/migrations/*.sql in lexical order, once each, tracked in schema_migrations.
# Runs inside the postgres image (psql available). Idempotent: safe on every `compose up`.
set -eu
psql -v ON_ERROR_STOP=1 -q -c "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())"
for f in $(ls /migrations/*.sql | sort); do
  name=$(basename "$f")
  if psql -tA -c "select 1 from schema_migrations where name = '$name'" | grep -q 1; then
    echo "[migrate] skip $name"
    continue
  fi
  echo "[migrate] apply $name"
  psql -v ON_ERROR_STOP=1 -q -1 -f "$f"
  psql -v ON_ERROR_STOP=1 -q -c "insert into schema_migrations (name) values ('$name')"
done
echo "[migrate] done"
