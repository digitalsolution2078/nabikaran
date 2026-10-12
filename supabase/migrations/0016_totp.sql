-- 0016: Authenticator-app two-step sign-in (TOTP, RFC 6238). Additive, re-runnable.
-- The secret is stored encrypted with the server key (like provider keys).
-- totp_enabled_at null = set-up started but not confirmed (not enforced).
alter table users add column if not exists totp_secret text;
alter table users add column if not exists totp_enabled_at timestamptz;
-- Highest time-step already used, so a code can be used only once.
alter table users add column if not exists totp_last_step bigint;

create table if not exists totp_recovery_codes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references users(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists totp_recovery_user_idx on totp_recovery_codes (user_id) where used_at is null;
