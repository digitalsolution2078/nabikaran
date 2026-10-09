-- Phase 0 (MCP-ready core): additive only. No wallet/payment tables are touched.

-- Who acted, through which channel. Web sessions write via='web'; MCP tokens
-- (Phase 2+) write via='mcp' with the OAuth client and token ids.
alter table audit_events
  add column if not exists actor_via       text not null default 'system'
    check (actor_via in ('system','web','mcp','worker')),
  add column if not exists actor_client_id text,
  add column if not exists actor_token_id  uuid;

-- Idempotency for mutations that reserve credits or change schedules.
-- A key is scoped to the user; the stored response is returned verbatim on replay.
create table if not exists idempotency_keys (
  user_id    uuid not null references users(id) on delete cascade,
  key        text not null,
  operation  text not null,
  response   jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists idempotency_keys_created_idx on idempotency_keys(created_at);

-- Fixed-window request counters (per token / user / tool). DB-backed so limits
-- survive restarts and apply across serverless instances, like the OTP limiter.
create table if not exists request_counters (
  subject      text not null,
  bucket       text not null,
  window_start timestamptz not null,
  n            int not null default 0,
  primary key (subject, bucket, window_start)
);
create index if not exists request_counters_window_idx on request_counters(window_start);

alter table idempotency_keys enable row level security;
alter table request_counters enable row level security;
