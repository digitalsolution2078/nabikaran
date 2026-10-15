-- 0026: Message usage. Balance checks of the SMS provider account (Aakash
-- credits left) and a count of every SMS and email that is not a reminder
-- (sign-in codes, nudges, alerts, digests, welcome, tests); reminder SMS,
-- WhatsApp and email are already in sms_attempts. Additive, re-runnable.

create table if not exists message_usage (
  id         bigint generated always as identity primary key,
  channel    text not null check (channel in ('sms','whatsapp','email')),
  kind       text not null,
  provider   text not null,
  outcome    text not null check (outcome in ('accepted','rejected','unknown')),
  segments   int not null default 1,
  units      numeric(10,2),
  created_at timestamptz not null default now()
);
create index if not exists message_usage_created_idx on message_usage (created_at);

create table if not exists sms_balance_checks (
  id         bigint generated always as identity primary key,
  provider   text not null,
  available  numeric(14,2),
  total_sent numeric(14,0),
  error_text text,
  checked_at timestamptz not null default now()
);
create index if not exists sms_balance_checks_at_idx on sms_balance_checks (checked_at desc);
