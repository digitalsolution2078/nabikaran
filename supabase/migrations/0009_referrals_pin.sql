-- 0009: referral programme and optional PIN sign-in. Additive, re-runnable.

-- Referral code (created on first use) and who invited the user.
alter table users add column if not exists referral_code text;
create unique index if not exists users_referral_code_idx on users (referral_code) where referral_code is not null;
alter table users add column if not exists referred_by uuid references users(id) on delete set null;
alter table users add column if not exists referred_at timestamptz;

-- Optional quick sign-in PIN (scrypt hash, never the PIN). A locked PIN is
-- unlocked only by a normal OTP sign-in.
alter table users add column if not exists pin_hash text;
alter table users add column if not exists pin_set_at timestamptz;
alter table users add column if not exists pin_failed_count int not null default 0;
alter table users add column if not exists pin_locked boolean not null default false;

-- One row per invited customer. Rewards are paid only after the invited
-- customer's first qualifying paid top-up (settings key 'referral').
create table if not exists referral_rewards (
  id               uuid primary key default gen_random_uuid(),
  referrer_id      uuid not null references users(id) on delete cascade,
  referee_id       uuid not null unique references users(id) on delete cascade,
  status           text not null default 'pending' check (status in ('pending','rewarded','capped','disabled')),
  referrer_credits bigint not null default 0,
  referee_credits  bigint not null default 0,
  created_at       timestamptz not null default now(),
  decided_at       timestamptz
);
create index if not exists referral_rewards_referrer_idx on referral_rewards (referrer_id, status);

-- Ledger type for referral bonuses.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'wallet_ledger'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'type'
  loop
    execute format('alter table wallet_ledger drop constraint %I', c.conname);
  end loop;
  alter table wallet_ledger add constraint wallet_ledger_type_check
    check (type in ('topup','debit','reversal','adjustment','fee','referral'));
end $$;

-- Credit a referral bonus exactly once per (reward, side).
create or replace function wallet_credit_referral(p_user uuid, p_credits bigint, p_reward uuid, p_side text)
returns boolean language plpgsql as $$
declare w wallets; k text;
begin
  if p_credits <= 0 then return false; end if;
  if p_side not in ('referrer','referee') then raise exception 'invalid side'; end if;
  k := 'referral:' || p_reward::text || ':' || p_side;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return false; end if;
  w := wallet_lock(p_user);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (p_user, 'referral', p_credits, 'referral_reward', p_reward::text, k, 'Referral bonus (' || p_side || ')');
  update wallets set posted_balance_credits = posted_balance_credits + p_credits, version = version + 1, updated_at = now() where user_id = p_user;
  return true;
end $$;
