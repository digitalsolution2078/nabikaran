-- 0014: Admin can ban (suspend) a customer. Additive, re-runnable.
-- A ban keeps everything (reminders, wallet, ledger, payments, history): the
-- account is set to status 'suspended', which blocks sign-in, connected apps
-- and message sending. Reminders that were active are paused and marked so an
-- unban resumes exactly those.
alter table users add column if not exists banned_at timestamptz;
alter table users add column if not exists banned_by uuid references users(id) on delete set null;
alter table users add column if not exists ban_reason text;
alter table users add column if not exists ban_until timestamptz;
alter table renewal_items add column if not exists ban_paused boolean not null default false;

create table if not exists user_bans (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references users(id) on delete cascade,
  action     text not null check (action in ('ban','unban')),
  reason     text,
  until      timestamptz,
  actor_id   uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists user_bans_user_idx on user_bans (user_id, created_at desc);
create index if not exists users_ban_until_idx on users (ban_until) where status = 'suspended' and ban_until is not null;
