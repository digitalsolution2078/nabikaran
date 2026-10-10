-- 0010: free web push notifications (PWA). Additive, re-runnable.

-- One row per browser/device that allowed notifications.
create table if not exists push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count   int not null default 0
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- One push per reminder occurrence, even when it also goes by SMS and WhatsApp.
create table if not exists push_deliveries (
  key        text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  sent       int not null default 0,
  created_at timestamptz not null default now()
);

-- Server-only secrets the app creates for itself (VAPID key pair).
-- Never exposed through app_settings or the admin settings API.
create table if not exists app_secrets (
  key        text primary key,
  value      jsonb not null,
  created_at timestamptz not null default now()
);
