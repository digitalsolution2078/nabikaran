-- Nabikaran core schema (PostgreSQL / Supabase)
-- All money/dispatch invariants live here so that application bugs cannot
-- mint credits, double-charge or double-send. See docs/ARCHITECTURE.md.

-- gen_random_uuid() is built into PostgreSQL 13+ (no pgcrypto needed).

-- ---------------------------------------------------------------------------
-- Users & authentication
-- ---------------------------------------------------------------------------
create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  auth_uid          text unique,                       -- optional Supabase auth / Google link
  phone_e164        text unique not null,
  phone_verified_at timestamptz,
  locale            text not null default 'ne-NP',
  timezone          text not null default 'Asia/Kathmandu',
  role              text not null default 'user' check (role in ('user','admin')),
  status            text not null default 'active' check (status in ('active','suspended','closed')),
  display_name      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists phone_verifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete set null,
  phone_e164   text not null,
  otp_hash     text not null,
  expires_at   timestamptz not null,
  attempts     int not null default 0,
  consumed_at  timestamptz,
  ip_hash      text,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index if not exists phone_verifications_phone_idx on phone_verifications(phone_e164, created_at desc);
create index if not exists phone_verifications_ip_idx on phone_verifications(ip_hash, created_at desc);

-- ---------------------------------------------------------------------------
-- Pricing (versioned, prospective only)
-- ---------------------------------------------------------------------------
create table if not exists pricing_versions (
  id                        bigint generated always as identity primary key,
  effective_at              timestamptz not null default now(),
  credits_per_billable_unit int not null check (credits_per_billable_unit > 0),
  pricing_policy            jsonb not null default '{}'::jsonb,
  created_by                uuid references users(id),
  created_at                timestamptz not null default now()
);

create table if not exists topup_packs (
  code         text primary key,
  amount_paisa bigint not null check (amount_paisa > 0),
  credits      bigint not null check (credits > 0),
  active       boolean not null default true,
  sort_order   int not null default 0
);

-- ---------------------------------------------------------------------------
-- Renewals, rules, jobs
-- ---------------------------------------------------------------------------
create table if not exists renewal_items (
  id                  uuid primary key default gen_random_uuid(),
  owner_user_id       uuid not null references users(id) on delete cascade,
  category            text not null,
  label               text not null,
  expiry_at_utc       timestamptz not null,
  local_time          text not null default '09:00',   -- HH:MM in Asia/Kathmandu
  date_input_calendar text not null default 'AD' check (date_input_calendar in ('AD','BS')),
  date_input_raw      text,
  notes               text,
  family_member_label text,
  status              text not null default 'active' check (status in ('active','paused','cancelled','deleted')),
  cycle_no            int not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists renewal_items_owner_idx on renewal_items(owner_user_id, status);

create table if not exists reminder_rules (
  id             uuid primary key default gen_random_uuid(),
  renewal_id     uuid not null references renewal_items(id) on delete cascade,
  offset_minutes int not null check (offset_minutes >= 0),
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (renewal_id, offset_minutes)
);

-- Job lifecycle:
--   planned          beyond the scheduling horizon; no reservation yet
--   awaiting_credits due inside horizon but wallet could not cover the estimate
--   scheduled        reservation held, waiting for due_at
--   sending          leased by a dispatcher worker, provider call in flight
--   submitted        provider accepted; wallet debited once
--   delivered        provider report confirmed delivery
--   failed           provider rejected (credits reversed) or retries exhausted
--   unknown          provider outcome ambiguous; needs reconciliation, never blind resend
--   cancelled        renewal edited/cancelled before send
create table if not exists reminder_jobs (
  id                 uuid primary key default gen_random_uuid(),
  renewal_id         uuid not null references renewal_items(id) on delete cascade,
  rule_id            uuid not null references reminder_rules(id) on delete cascade,
  user_id            uuid not null references users(id) on delete cascade,
  cycle_no           int not null,
  due_at_utc         timestamptz not null,
  cost_version       bigint references pricing_versions(id),
  estimated_segments int not null default 1,
  estimated_credits  bigint not null default 0,
  status             text not null default 'planned' check (status in
                       ('planned','awaiting_credits','scheduled','sending','submitted',
                        'delivered','failed','unknown','cancelled')),
  attempts           int not null default 0,
  next_attempt_at    timestamptz,
  lock_at            timestamptz,
  lock_token         text,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (renewal_id, rule_id, cycle_no)
);
create index if not exists reminder_jobs_due_idx on reminder_jobs(status, due_at_utc);
create index if not exists reminder_jobs_user_idx on reminder_jobs(user_id, due_at_utc desc);

-- ---------------------------------------------------------------------------
-- Wallet: posted balance, reservations, append-only ledger
-- ---------------------------------------------------------------------------
create table if not exists wallets (
  user_id                uuid primary key references users(id) on delete cascade,
  posted_balance_credits bigint not null default 0 check (posted_balance_credits >= 0),
  reserved_credits       bigint not null default 0 check (reserved_credits >= 0),
  version                bigint not null default 0,
  updated_at             timestamptz not null default now(),
  check (reserved_credits <= posted_balance_credits)
);

create table if not exists wallet_ledger (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references users(id) on delete cascade,
  type            text not null check (type in ('topup','debit','reversal','adjustment')),
  signed_credits  bigint not null,
  reference_type  text,
  reference_id    text,
  idempotency_key text not null unique,
  memo            text,
  created_at      timestamptz not null default now()
);
create index if not exists wallet_ledger_user_idx on wallet_ledger(user_id, created_at desc);

create or replace function wallet_ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'wallet_ledger is append-only';
end $$;
drop trigger if exists wallet_ledger_no_update on wallet_ledger;
create trigger wallet_ledger_no_update before update or delete on wallet_ledger
  for each row execute function wallet_ledger_append_only();

create table if not exists credit_reservations (
  id              uuid primary key default gen_random_uuid(),
  reminder_job_id uuid not null unique references reminder_jobs(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  held_credits    bigint not null check (held_credits >= 0),
  status          text not null default 'active' check (status in ('active','committed','released')),
  created_at      timestamptz not null default now(),
  released_at     timestamptz
);

-- Dual-approval administrative wallet adjustments
create table if not exists wallet_adjustment_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id),
  signed_credits bigint not null check (signed_credits <> 0),
  reason         text not null,
  requested_by   uuid not null references users(id),
  approved_by    uuid references users(id),
  status         text not null default 'pending' check (status in ('pending','approved','rejected','applied')),
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  check (approved_by is null or approved_by <> requested_by)
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create table if not exists payment_orders (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete cascade,
  gateway                 text not null check (gateway in ('khalti','esewa','mock')),
  order_reference         text not null unique,
  pack_code               text references topup_packs(code),
  amount_paisa            bigint not null check (amount_paisa > 0),
  credits                 bigint not null check (credits > 0),
  status                  text not null default 'initiated' check (status in
                            ('initiated','pending','paid','failed','cancelled','expired','refunded')),
  gateway_ref             text,                                   -- Khalti pidx / eSewa transaction uuid
  verified_transaction_id text,
  payment_url             text,
  created_at              timestamptz not null default now(),
  paid_at                 timestamptz,
  updated_at              timestamptz not null default now(),
  unique (gateway, verified_transaction_id)
);
create index if not exists payment_orders_gateway_ref_idx on payment_orders(gateway, order_reference);
create index if not exists payment_orders_user_idx on payment_orders(user_id, created_at desc);

create table if not exists payment_events (
  id               bigint generated always as identity primary key,
  payment_order_id uuid references payment_orders(id) on delete cascade,
  gateway_event_id text unique,
  payload_hash     text not null,
  event_type       text not null,
  payload          jsonb,
  received_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- SMS
-- ---------------------------------------------------------------------------
create table if not exists sms_templates (
  id               bigint generated always as identity primary key,
  locale           text not null,
  category         text not null,
  template_version int not null default 1,
  body             text not null,
  active           boolean not null default true,
  unique (locale, category, template_version)
);

create table if not exists sms_attempts (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references reminder_jobs(id) on delete cascade,
  attempt_no          int not null,
  provider            text not null,
  idempotency_key     text not null unique,
  provider_message_id text unique,
  api_state           text not null default 'pending' check (api_state in ('pending','accepted','rejected','unknown')),
  reported_units      int,
  reported_status     text,
  error_text          text,
  request_at          timestamptz not null default now(),
  response_at         timestamptz,
  unique (job_id, attempt_no)
);
create index if not exists sms_attempts_job_idx on sms_attempts(job_id, attempt_no);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
create table if not exists audit_events (
  id                   bigint generated always as identity primary key,
  actor_user_id        uuid references users(id),
  action               text not null,
  target_type          text,
  target_id            text,
  json_detail_redacted jsonb,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
insert into pricing_versions (credits_per_billable_unit, pricing_policy)
select 3, '{"note":"provisional retail; 1 credit = NPR 1"}'::jsonb
where not exists (select 1 from pricing_versions);

insert into topup_packs (code, amount_paisa, credits, sort_order) values
  ('NPR20',   2000,  20, 1),
  ('NPR50',   5000,  50, 2),
  ('NPR100', 10000, 100, 3),
  ('NPR250', 25000, 250, 4)
on conflict (code) do nothing;

insert into sms_templates (locale, category, body) values
  ('ne-NP', 'default', 'Nabikaran: तपाईंको {label} को म्याद {days} दिनमा सकिन्छ ({date})। समयमै नवीकरण गर्नुहोस्।'),
  ('ne-NP', 'today',   'Nabikaran: तपाईंको {label} को म्याद आज ({date}) सकिन्छ। समयमै नवीकरण गर्नुहोस्।'),
  ('en-NP', 'default', 'Nabikaran: Your {label} expires in {days} day(s) on {date}. Renew on time.'),
  ('en-NP', 'today',   'Nabikaran: Your {label} expires today ({date}). Renew on time.')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Wallet functions. All are the ONLY way the service may mutate balances.
-- ---------------------------------------------------------------------------

-- Ensure a wallet row exists and lock it.
create or replace function wallet_lock(p_user_id uuid) returns wallets language plpgsql as $$
declare w wallets;
begin
  insert into wallets (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into w from wallets where user_id = p_user_id for update;
  return w;
end $$;

-- Credit a paid top-up exactly once. Caller must already have verified the
-- payment with the gateway. Returns true if credits were issued now, false if
-- the order was already credited (idempotent replay).
create or replace function wallet_apply_topup(p_order_id uuid, p_verified_transaction_id text)
returns boolean language plpgsql as $$
declare o payment_orders; k text; w wallets;
begin
  select * into o from payment_orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  k := 'topup:' || o.id::text;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then
    return false;
  end if;
  w := wallet_lock(o.user_id);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key)
    values (o.user_id, 'topup', o.credits, 'payment_order', o.id::text, k);
  update wallets set posted_balance_credits = posted_balance_credits + o.credits,
                     version = version + 1, updated_at = now()
    where user_id = o.user_id;
  update payment_orders set status = 'paid', paid_at = coalesce(paid_at, now()),
                            verified_transaction_id = coalesce(verified_transaction_id, p_verified_transaction_id),
                            updated_at = now()
    where id = o.id;
  return true;
end $$;

-- Reverse a refunded/charged-back top-up. Creates a reversing ledger entry.
-- If the user already spent the credits, the wallet cannot go negative: the
-- shortfall is returned for admin/financial exception handling.
create or replace function wallet_reverse_topup(p_order_id uuid, p_reason text)
returns bigint language plpgsql as $$
declare o payment_orders; k text; w wallets; avail bigint; take bigint;
begin
  select * into o from payment_orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  k := 'topup-reversal:' || o.id::text;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return 0; end if;
  w := wallet_lock(o.user_id);
  avail := w.posted_balance_credits - w.reserved_credits;
  take := least(avail, o.credits);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (o.user_id, 'reversal', -take, 'payment_order', o.id::text, k, p_reason);
  update wallets set posted_balance_credits = posted_balance_credits - take,
                     version = version + 1, updated_at = now() where user_id = o.user_id;
  update payment_orders set status = 'refunded', updated_at = now() where id = o.id;
  return o.credits - take; -- shortfall (0 when fully reversed)
end $$;

-- Reserve the estimated cost of a job. Idempotent per job: re-reserving
-- adjusts the hold up/down. Returns the resulting job status
-- ('scheduled' or 'awaiting_credits').
create or replace function wallet_reserve_for_job(p_job_id uuid) returns text language plpgsql as $$
declare j reminder_jobs; w wallets; r credit_reservations; avail bigint; delta bigint;
begin
  select * into j from reminder_jobs where id = p_job_id for update;
  if not found then raise exception 'job not found'; end if;
  if j.status not in ('planned','awaiting_credits','scheduled') then
    return j.status;
  end if;
  w := wallet_lock(j.user_id);
  select * into r from credit_reservations where reminder_job_id = j.id for update;
  if found and r.status = 'active' then
    delta := j.estimated_credits - r.held_credits;
  else
    delta := j.estimated_credits;
  end if;
  avail := w.posted_balance_credits - w.reserved_credits;
  if delta > avail then
    -- insufficient: keep any existing hold, mark awaiting credits
    update reminder_jobs set status = 'awaiting_credits', updated_at = now() where id = j.id;
    return 'awaiting_credits';
  end if;
  if found and r.status = 'active' then
    update credit_reservations set held_credits = j.estimated_credits where id = r.id;
  elsif found then
    update credit_reservations set held_credits = j.estimated_credits, status = 'active', released_at = null where id = r.id;
  else
    insert into credit_reservations (reminder_job_id, user_id, held_credits) values (j.id, j.user_id, j.estimated_credits);
  end if;
  update wallets set reserved_credits = reserved_credits + delta, version = version + 1, updated_at = now()
    where user_id = j.user_id;
  update reminder_jobs set status = 'scheduled', updated_at = now() where id = j.id;
  return 'scheduled';
end $$;

-- Release an active reservation (cancel / reject). Never touches posted balance.
create or replace function wallet_release_for_job(p_job_id uuid) returns bigint language plpgsql as $$
declare r credit_reservations; w wallets;
begin
  select * into r from credit_reservations where reminder_job_id = p_job_id for update;
  if not found or r.status <> 'active' then return 0; end if;
  w := wallet_lock(r.user_id);
  update wallets set reserved_credits = reserved_credits - r.held_credits, version = version + 1, updated_at = now()
    where user_id = r.user_id;
  update credit_reservations set status = 'released', released_at = now() where id = r.id;
  return r.held_credits;
end $$;

-- Convert a reservation into a committed debit for the actual billable
-- amount, exactly once per attempt (idempotency key). Any unused hold is
-- released. If actual > held, the extra is taken from available balance when
-- possible; the wallet never goes negative.
create or replace function wallet_commit_for_job(p_job_id uuid, p_actual_credits bigint, p_idempotency_key text)
returns bigint language plpgsql as $$
declare r credit_reservations; w wallets; held bigint; charge bigint; avail bigint;
begin
  if exists (select 1 from wallet_ledger where idempotency_key = p_idempotency_key) then
    return (select -signed_credits from wallet_ledger where idempotency_key = p_idempotency_key);
  end if;
  select * into r from credit_reservations where reminder_job_id = p_job_id for update;
  if not found then raise exception 'no reservation for job %', p_job_id; end if;
  if r.status <> 'active' then raise exception 'reservation not active for job %', p_job_id; end if;
  w := wallet_lock(r.user_id);
  held := r.held_credits;
  avail := w.posted_balance_credits - w.reserved_credits;
  charge := least(p_actual_credits, held + avail);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key)
    values (r.user_id, 'debit', -charge, 'reminder_job', p_job_id::text, p_idempotency_key);
  update wallets set posted_balance_credits = posted_balance_credits - charge,
                     reserved_credits = reserved_credits - held,
                     version = version + 1, updated_at = now()
    where user_id = r.user_id;
  update credit_reservations set status = 'committed', held_credits = charge, released_at = now() where id = r.id;
  return charge;
end $$;

-- Reverse a committed debit (provider rejected after we charged). Idempotent.
create or replace function wallet_reverse_debit_for_job(p_job_id uuid, p_idempotency_key text)
returns bigint language plpgsql as $$
declare orig wallet_ledger; k text; w wallets;
begin
  k := 'reversal:' || p_idempotency_key;
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

-- Apply an approved dual-signed administrative adjustment exactly once.
create or replace function wallet_apply_adjustment(p_request_id uuid) returns boolean language plpgsql as $$
declare a wallet_adjustment_requests; k text; w wallets; avail bigint;
begin
  select * into a from wallet_adjustment_requests where id = p_request_id for update;
  if not found then raise exception 'adjustment not found'; end if;
  if a.status <> 'approved' or a.approved_by is null or a.approved_by = a.requested_by then
    raise exception 'adjustment requires approval by a second admin';
  end if;
  k := 'adjustment:' || a.id::text;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return false; end if;
  w := wallet_lock(a.user_id);
  avail := w.posted_balance_credits - w.reserved_credits;
  if a.signed_credits < 0 and -a.signed_credits > avail then
    raise exception 'adjustment would overdraw available balance';
  end if;
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (a.user_id, 'adjustment', a.signed_credits, 'wallet_adjustment_request', a.id::text, k, a.reason);
  update wallets set posted_balance_credits = posted_balance_credits + a.signed_credits,
                     version = version + 1, updated_at = now() where user_id = a.user_id;
  update wallet_adjustment_requests set status = 'applied', decided_at = now() where id = a.id;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- Dispatcher: lease due jobs safely across concurrent workers.
-- ---------------------------------------------------------------------------
create or replace function jobs_claim_due(p_limit int, p_lease_seconds int, p_token text)
returns setof reminder_jobs language plpgsql as $$
begin
  return query
  with cte as (
    select j.id from reminder_jobs j
    where j.status = 'scheduled'
      and j.due_at_utc <= now()
      and (j.next_attempt_at is null or j.next_attempt_at <= now())
      and (j.lock_at is null or j.lock_at < now())
    order by j.due_at_utc
    limit p_limit
    for update skip locked
  )
  update reminder_jobs j
     set status = 'sending', lock_at = now() + make_interval(secs => p_lease_seconds),
         lock_token = p_token, updated_at = now()
    from cte where j.id = cte.id
  returning j.*;
end $$;

-- Release jobs whose worker died mid-send without recording an attempt
-- outcome. Jobs with a pending attempt become 'unknown' (reconcile, never
-- blind resend).
create or replace function jobs_recover_stale_leases() returns int language plpgsql as $$
declare n int;
begin
  with stale as (
    select j.id,
           exists (select 1 from sms_attempts a where a.job_id = j.id and a.api_state = 'pending') as has_pending
      from reminder_jobs j
     where j.status = 'sending' and j.lock_at < now()
  ),
  upd as (
    update reminder_jobs j
       set status = case when s.has_pending then 'unknown' else 'scheduled' end,
           lock_at = null, lock_token = null, updated_at = now()
      from stale s where j.id = s.id
    returning 1
  )
  select count(*) into n from upd;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security. The application server uses the service role; these
-- policies are defence-in-depth so no anon/authenticated client can read or
-- mutate another user's rows if direct Supabase access is ever enabled.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['users','phone_verifications','renewal_items','reminder_rules','reminder_jobs',
                           'wallets','wallet_ledger','credit_reservations','wallet_adjustment_requests',
                           'payment_orders','payment_events','sms_attempts','sms_templates',
                           'pricing_versions','audit_events','topup_packs']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Read-only self access through Supabase auth (auth.uid() maps to users.auth_uid).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    execute $p$create policy users_self_read on users for select
      using (auth_uid = (select auth.uid()::text))$p$;
    execute $p$create policy renewals_self_read on renewal_items for select
      using (owner_user_id in (select id from users where auth_uid = (select auth.uid()::text)))$p$;
    execute $p$create policy jobs_self_read on reminder_jobs for select
      using (user_id in (select id from users where auth_uid = (select auth.uid()::text)))$p$;
    execute $p$create policy wallets_self_read on wallets for select
      using (user_id in (select id from users where auth_uid = (select auth.uid()::text)))$p$;
    execute $p$create policy ledger_self_read on wallet_ledger for select
      using (user_id in (select id from users where auth_uid = (select auth.uid()::text)))$p$;
    execute $p$create policy packs_public_read on topup_packs for select using (active)$p$;
  end if;
exception when duplicate_object then null;
end $$;
