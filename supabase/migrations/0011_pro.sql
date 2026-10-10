-- 0011: Pro plan (trial, yearly plan, message allowances), email channel and
-- email sign-in, subscription manager fields. Additive, re-runnable.

-- ---------------------------------------------------------------------------
-- 1. Plans
-- ---------------------------------------------------------------------------
-- trial: Pro features, no included messages. paid: bought from the wallet.
-- grant: given by an admin (counts like paid).
create table if not exists user_plans (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  kind          text not null check (kind in ('trial','paid','grant')),
  status        text not null default 'active' check (status in ('active','revoked')),
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz not null,
  price_credits bigint not null default 0 check (price_credits >= 0),
  created_by    uuid references users(id) on delete set null,
  note          text,
  created_at    timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists user_plans_user_idx on user_plans (user_id, ends_at desc);
-- One free trial per account, ever.
create unique index if not exists user_plans_one_trial on user_plans (user_id) where kind = 'trial';

-- Included messages per plan and channel (paid and grant plans only).
create table if not exists plan_allowances (
  user_plan_id uuid not null references user_plans(id) on delete cascade,
  channel      text not null check (channel in ('sms','whatsapp','email')),
  granted      int not null check (granted >= 0),
  reserved     int not null default 0 check (reserved >= 0),
  used         int not null default 0 check (used >= 0),
  primary key (user_plan_id, channel)
);

-- Every use and refund of an included message (idempotent, for reports).
create table if not exists allowance_events (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references users(id) on delete cascade,
  user_plan_id    uuid not null references user_plans(id) on delete cascade,
  channel         text not null,
  units           int not null,
  kind            text not null check (kind in ('use','refund')),
  reminder_job_id uuid,
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);

-- A reservation is funded either by credits (held_credits) or by included messages.
alter table credit_reservations add column if not exists allowance_plan_id uuid references user_plans(id) on delete set null;
alter table credit_reservations add column if not exists allowance_units int not null default 0;

-- Ledger type for buying a plan with wallet credits.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'wallet_ledger'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'type'
  loop
    execute format('alter table wallet_ledger drop constraint %I', c.conname);
  end loop;
  alter table wallet_ledger add constraint wallet_ledger_type_check
    check (type in ('topup','debit','reversal','adjustment','fee','referral','plan'));
end $$;

-- Pay for a plan from the wallet, exactly once per plan row. Never creates debt.
create or replace function wallet_buy_plan(p_user uuid, p_credits bigint, p_plan uuid)
returns boolean language plpgsql as $$
declare w wallets; k text;
begin
  k := 'plan:' || p_plan::text;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return false; end if;
  w := wallet_lock(p_user);
  if p_credits > 0 then
    if w.posted_balance_credits - w.reserved_credits < p_credits then
      raise exception 'insufficient_credits';
    end if;
    insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
      values (p_user, 'plan', -p_credits, 'user_plan', p_plan::text, k, 'Nabikaran Pro');
    update wallets set posted_balance_credits = posted_balance_credits - p_credits, version = version + 1, updated_at = now() where user_id = p_user;
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Email channel
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'renewal_items'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'channels'
  loop execute format('alter table renewal_items drop constraint %I', c.conname); end loop;
  alter table renewal_items add constraint renewal_items_channels_check
    check (cardinality(channels) between 1 and 3 and channels <@ array['sms','whatsapp','email']::text[]);

  for c in select conname from pg_constraint where conrelid = 'reminder_jobs'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'channel'
  loop execute format('alter table reminder_jobs drop constraint %I', c.conname); end loop;
  alter table reminder_jobs add constraint reminder_jobs_channel_check check (channel in ('sms','whatsapp','email'));

  for c in select conname from pg_constraint where conrelid = 'pricing_versions'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'channel'
  loop execute format('alter table pricing_versions drop constraint %I', c.conname); end loop;
  alter table pricing_versions add constraint pricing_versions_channel_check check (channel in ('sms','whatsapp','email'));
end $$;

insert into pricing_versions (credits_per_billable_unit, pricing_policy, channel)
select 1, '{"note":"email reminder beyond the Pro allowance"}'::jsonb, 'email'
where not exists (select 1 from pricing_versions where channel = 'email');

-- Verified email (Pro: sign-in and email reminders).
alter table users add column if not exists email_verified_at timestamptz;

create table if not exists email_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete cascade,
  email       text not null,
  purpose     text not null check (purpose in ('verify','login')),
  code_hash   text not null,
  attempts    int not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists email_codes_email_idx on email_codes (lower(email), purpose, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Subscription manager
-- ---------------------------------------------------------------------------
alter table renewal_items add column if not exists sub_amount numeric(12,2);
alter table renewal_items add column if not exists sub_currency text;
alter table renewal_items add column if not exists sub_payment_method text;
alter table renewal_items add column if not exists sub_auto_renew boolean;
-- Repeat every N months, 1–11 (monthly, quarterly, half-yearly, custom); yearly keeps using repeat_yearly.
-- Available on every plan.
alter table renewal_items add column if not exists repeat_months int;
-- Pro: a free trial (the date is when it turns into a paid subscription), and
-- a cancellation deadline N days before the renewal date.
alter table renewal_items add column if not exists sub_is_trial boolean not null default false;
alter table renewal_items add column if not exists cancel_notice_days int;
-- A reminder managed by another one (the "cancel by" reminder of a subscription).
alter table renewal_items add column if not exists linked_to uuid references renewal_items(id) on delete cascade;
create index if not exists renewal_items_linked_idx on renewal_items (linked_to) where linked_to is not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'renewal_items_repeat_months_check') then
    alter table renewal_items add constraint renewal_items_repeat_months_check check (repeat_months is null or repeat_months between 1 and 11);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'renewal_items_cancel_notice_check') then
    alter table renewal_items add constraint renewal_items_cancel_notice_check check (cancel_notice_days is null or cancel_notice_days between 0 and 90);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'renewal_items_sub_amount_check') then
    alter table renewal_items add constraint renewal_items_sub_amount_check check (sub_amount is null or sub_amount >= 0);
  end if;
end $$;

-- Pro: renewal history (marked renewed by the customer, or a subscription that rolled over).
create table if not exists renewal_history (
  id            uuid primary key default gen_random_uuid(),
  renewal_id    uuid references renewal_items(id) on delete set null,
  user_id       uuid not null references users(id) on delete cascade,
  label         text not null,
  category      text not null,
  renewed_on    date not null,
  amount        numeric(12,2) check (amount is null or amount >= 0),
  currency      text,
  previous_due  timestamptz,
  next_due      timestamptz,
  source        text not null check (source in ('manual','auto')),
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists renewal_history_user_idx on renewal_history (user_id, renewed_on desc);

-- Customer preferences for Pro.
-- pro_credit_fallback: when included messages run out, use wallet credits without asking again.
alter table users add column if not exists pro_credit_fallback boolean not null default false;
alter table users add column if not exists digest_frequency text not null default 'weekly';
alter table users add column if not exists last_digest_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_digest_frequency_check') then
    alter table users add constraint users_digest_frequency_check check (digest_frequency in ('off','weekly','monthly'));
  end if;
end $$;

-- One-off notices already sent (e.g. "Pro ends in 14 days"), so each goes once.
create table if not exists user_notices (
  key        text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Wallet functions that also use included messages
-- ---------------------------------------------------------------------------

-- The plan whose included messages can fund this message: an active paid or
-- granted plan, the message due before the plan ends, enough left.
create or replace function plan_allowance_pick(p_user uuid, p_channel text, p_units int, p_due timestamptz)
returns uuid language plpgsql as $$
declare pid uuid;
begin
  select a.user_plan_id into pid
    from plan_allowances a join user_plans p on p.id = a.user_plan_id
   where p.user_id = p_user and p.status = 'active' and p.kind in ('paid','grant')
     and p.starts_at <= now() and p.ends_at > now() and p_due < p.ends_at
     and a.channel = p_channel and a.granted - a.reserved - a.used >= p_units
   order by p.ends_at
   limit 1
   for update of a;
  return pid;
end $$;

create or replace function wallet_reserve_for_job(p_job_id uuid) returns text language plpgsql as $$
declare j reminder_jobs; w wallets; r credit_reservations; has_r boolean; active_r boolean;
        avail bigint; delta bigint; pid uuid; units int;
begin
  select * into j from reminder_jobs where id = p_job_id for update;
  if not found then raise exception 'job not found'; end if;
  if j.status not in ('planned','awaiting_credits','scheduled') then
    return j.status;
  end if;
  w := wallet_lock(j.user_id);
  units := greatest(j.estimated_segments, 1);
  select * into r from credit_reservations where reminder_job_id = j.id for update;
  has_r := found;
  active_r := has_r and r.status = 'active';

  -- An included-message hold: keep it when the size is unchanged, otherwise return it first.
  if active_r and r.allowance_units > 0 then
    if r.allowance_units = units then
      update reminder_jobs set status = 'scheduled', updated_at = now() where id = j.id;
      return 'scheduled';
    end if;
    update plan_allowances set reserved = greatest(reserved - r.allowance_units, 0)
     where user_plan_id = r.allowance_plan_id and channel = j.channel;
    update credit_reservations set status = 'released', released_at = now(), allowance_units = 0, allowance_plan_id = null where id = r.id;
    active_r := false;
  end if;

  -- Pro: included messages first.
  if not active_r then
    pid := plan_allowance_pick(j.user_id, j.channel, units, j.due_at_utc);
    if pid is not null then
      update plan_allowances set reserved = reserved + units where user_plan_id = pid and channel = j.channel;
      if has_r then
        update credit_reservations set held_credits = 0, status = 'active', released_at = null, allowance_plan_id = pid, allowance_units = units where id = r.id;
      else
        insert into credit_reservations (reminder_job_id, user_id, held_credits, allowance_plan_id, allowance_units)
          values (j.id, j.user_id, 0, pid, units);
      end if;
      update reminder_jobs set status = 'scheduled', updated_at = now() where id = j.id;
      return 'scheduled';
    end if;
  end if;

  -- Included messages used up while Pro is active: credits only with the customer's
  -- permission (asked when saving, or "use credits automatically" in Pro settings).
  if not active_r
     and coalesce(current_setting('nabikaran.allow_credits', true), '') <> 'on'
     and not coalesce((select u.pro_credit_fallback from users u where u.id = j.user_id), false)
     and exists (select 1 from user_plans p join plan_allowances a on a.user_plan_id = p.id and a.channel = j.channel
                  where p.user_id = j.user_id and p.status = 'active' and p.kind in ('paid','grant')
                    and p.starts_at <= now() and p.ends_at > now() and j.due_at_utc < p.ends_at and a.granted > 0) then
    update reminder_jobs set status = 'awaiting_credits', last_error = 'included messages used up: allow wallet credits', updated_at = now() where id = j.id;
    return 'needs_permission';
  end if;

  -- Credits (unchanged behaviour).
  if active_r then
    delta := j.estimated_credits - r.held_credits;
  else
    delta := j.estimated_credits;
  end if;
  avail := w.posted_balance_credits - w.reserved_credits;
  if delta > avail then
    update reminder_jobs set status = 'awaiting_credits', updated_at = now() where id = j.id;
    return 'awaiting_credits';
  end if;
  if active_r then
    update credit_reservations set held_credits = j.estimated_credits where id = r.id;
  elsif has_r then
    update credit_reservations set held_credits = j.estimated_credits, status = 'active', released_at = null, allowance_units = 0, allowance_plan_id = null where id = r.id;
  else
    insert into credit_reservations (reminder_job_id, user_id, held_credits) values (j.id, j.user_id, j.estimated_credits);
  end if;
  update wallets set reserved_credits = reserved_credits + delta, version = version + 1, updated_at = now()
    where user_id = j.user_id;
  update reminder_jobs set status = 'scheduled', last_error = null, updated_at = now() where id = j.id;
  return 'scheduled';
end $$;

create or replace function wallet_release_for_job(p_job_id uuid) returns bigint language plpgsql as $$
declare r credit_reservations; w wallets; ch text;
begin
  select * into r from credit_reservations where reminder_job_id = p_job_id for update;
  if not found or r.status <> 'active' then return 0; end if;
  if r.allowance_units > 0 then
    select channel into ch from reminder_jobs where id = p_job_id;
    update plan_allowances set reserved = greatest(reserved - r.allowance_units, 0)
     where user_plan_id = r.allowance_plan_id and channel = ch;
    update credit_reservations set status = 'released', released_at = now() where id = r.id;
    return 0;
  end if;
  w := wallet_lock(r.user_id);
  update wallets set reserved_credits = reserved_credits - r.held_credits, version = version + 1, updated_at = now()
    where user_id = r.user_id;
  update credit_reservations set status = 'released', released_at = now() where id = r.id;
  return r.held_credits;
end $$;

create or replace function wallet_commit_for_job(p_job_id uuid, p_actual_credits bigint, p_idempotency_key text)
returns bigint language plpgsql as $$
declare r credit_reservations; w wallets; held bigint; charge bigint; avail bigint; ch text;
begin
  if exists (select 1 from wallet_ledger where idempotency_key = p_idempotency_key) then
    return (select -signed_credits from wallet_ledger where idempotency_key = p_idempotency_key);
  end if;
  if exists (select 1 from allowance_events where idempotency_key = p_idempotency_key) then
    return 0;
  end if;
  select * into r from credit_reservations where reminder_job_id = p_job_id for update;
  if not found then raise exception 'no reservation for job %', p_job_id; end if;
  if r.status <> 'active' then raise exception 'reservation not active for job %', p_job_id; end if;
  if r.allowance_units > 0 then
    -- Included message: no credits are charged.
    select channel into ch from reminder_jobs where id = p_job_id;
    update plan_allowances set reserved = greatest(reserved - r.allowance_units, 0), used = used + r.allowance_units
     where user_plan_id = r.allowance_plan_id and channel = ch;
    insert into allowance_events (user_id, user_plan_id, channel, units, kind, reminder_job_id, idempotency_key)
      values (r.user_id, r.allowance_plan_id, ch, r.allowance_units, 'use', p_job_id, p_idempotency_key);
    update credit_reservations set status = 'committed', released_at = now() where id = r.id;
    return 0;
  end if;
  w := wallet_lock(r.user_id);
  held := r.held_credits;
  avail := w.posted_balance_credits - w.reserved_credits;
  charge := least(p_actual_credits, held + greatest(avail, 0));
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key)
    values (r.user_id, 'debit', -charge, 'reminder_job', p_job_id::text, p_idempotency_key);
  update wallets set posted_balance_credits = posted_balance_credits - charge,
                     reserved_credits = reserved_credits - held,
                     version = version + 1, updated_at = now()
    where user_id = r.user_id;
  update credit_reservations set status = 'committed', held_credits = charge, released_at = now() where id = r.id;
  return charge;
end $$;

-- A failed message gives back what it used: credits, or the included message.
create or replace function wallet_reverse_debit_for_job(p_job_id uuid, p_idempotency_key text)
returns bigint language plpgsql as $$
declare orig wallet_ledger; k text; w wallets; e allowance_events;
begin
  k := 'reversal:' || p_idempotency_key;
  select * into e from allowance_events where idempotency_key = p_idempotency_key and kind = 'use';
  if found then
    if exists (select 1 from allowance_events where idempotency_key = k) then return 0; end if;
    update plan_allowances set used = greatest(used - e.units, 0) where user_plan_id = e.user_plan_id and channel = e.channel;
    insert into allowance_events (user_id, user_plan_id, channel, units, kind, reminder_job_id, idempotency_key)
      values (e.user_id, e.user_plan_id, e.channel, e.units, 'refund', p_job_id, k);
    return 0;
  end if;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return 0; end if;
  select * into orig from wallet_ledger where idempotency_key = p_idempotency_key;
  if not found then return 0; end if;
  w := wallet_lock(orig.user_id);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key)
    values (orig.user_id, 'reversal', -orig.signed_credits, 'reminder_job', p_job_id::text, k);
  update wallets set posted_balance_credits = posted_balance_credits - orig.signed_credits,
                     version = version + 1, updated_at = now() where user_id = orig.user_id;
  return -orig.signed_credits;
end $$;
