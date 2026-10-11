-- 0013: Coupon codes (admin), gift cards and counter top-ups. Additive and re-runnable.
-- Credits can never be moved from one customer's wallet to another: a gift card is
-- bought with money (QR / Fonepay / cash at the counter), exactly like a top-up,
-- and only becomes usable once that payment is confirmed.

-- ---------------------------------------------------------------------------
-- 1. Ledger types and staff role
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'wallet_ledger'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'type'
  loop
    execute format('alter table wallet_ledger drop constraint %I', c.conname);
  end loop;
  alter table wallet_ledger add constraint wallet_ledger_type_check
    check (type in ('topup','debit','reversal','adjustment','fee','referral','plan','coupon','gift'));
end $$;

-- "counter": front-desk / agent staff who take cash and credit a customer's wallet. Nothing else.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('user','admin','super_admin','finance','support','content','auditor','counter'));

-- ---------------------------------------------------------------------------
-- 2. Codes
-- ---------------------------------------------------------------------------
-- A batch made by an admin: many single-use codes, or one shared promo code.
create table if not exists credit_code_batches (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  kind            text not null check (kind in ('single','shared')),
  credits         bigint not null check (credits > 0 and credits <= 100000),
  code_count      int not null check (code_count between 1 and 5000),
  max_redemptions int not null default 1 check (max_redemptions between 1 and 1000000),
  expires_at      timestamptz,
  status          text not null default 'active' check (status in ('active','disabled')),
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- Codes are looked up by hash; the code itself is stored encrypted (server key)
-- so an admin can download a batch again and a gift sender can see their code.
create table if not exists credit_codes (
  id              uuid primary key default gen_random_uuid(),
  source          text not null check (source in ('admin','gift')),
  batch_id        uuid references credit_code_batches(id) on delete cascade,
  code_hash       text not null unique,
  code_enc        text not null,
  code_hint       text not null,
  credits         bigint not null check (credits > 0),
  max_redemptions int not null default 1 check (max_redemptions >= 1),
  redeemed_count  int not null default 0 check (redeemed_count >= 0),
  expires_at      timestamptz,
  status          text not null default 'active' check (status in ('pending','active','disabled','used','cancelled')),
  created_by      uuid references users(id) on delete set null,
  gift_from_user  uuid references users(id) on delete set null,
  gift_to_name    text,
  gift_message    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists credit_codes_batch_idx on credit_codes (batch_id);
create index if not exists credit_codes_gift_idx on credit_codes (gift_from_user, created_at desc) where source = 'gift';

create table if not exists credit_code_redemptions (
  id         bigint generated always as identity primary key,
  code_id    uuid not null references credit_codes(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  credits    bigint not null,
  created_at timestamptz not null default now(),
  unique (code_id, user_id)
);
create index if not exists credit_code_redemptions_user_idx on credit_code_redemptions (user_id, created_at desc);

-- Redeem a code exactly once per customer. Errors are short machine codes.
create or replace function credit_code_redeem(p_user uuid, p_hash text)
returns jsonb language plpgsql as $$
declare c credit_codes; bstatus text; w wallets; k text; t text;
begin
  select * into c from credit_codes where code_hash = p_hash for update;
  if not found or c.status in ('pending','disabled','cancelled') then raise exception 'code_invalid'; end if;
  if c.batch_id is not null then
    select status into bstatus from credit_code_batches where id = c.batch_id;
    if bstatus <> 'active' then raise exception 'code_invalid'; end if;
  end if;
  if exists (select 1 from credit_code_redemptions where code_id = c.id and user_id = p_user) then raise exception 'code_already_redeemed'; end if;
  if c.status = 'used' or c.redeemed_count >= c.max_redemptions then raise exception 'code_used'; end if;
  if c.expires_at is not null and c.expires_at <= now() then raise exception 'code_expired'; end if;
  t := case when c.source = 'gift' then 'gift' else 'coupon' end;
  k := 'code:' || c.id::text || ':' || p_user::text;
  w := wallet_lock(p_user);
  insert into credit_code_redemptions (code_id, user_id, credits) values (c.id, p_user, c.credits);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (p_user, t, c.credits, 'credit_code', c.id::text, k,
            case when t = 'gift' then 'Gift card received …' else 'Coupon …' end || c.code_hint);
  update wallets set posted_balance_credits = posted_balance_credits + c.credits, version = version + 1, updated_at = now() where user_id = p_user;
  update credit_codes
     set redeemed_count = redeemed_count + 1,
         status = case when redeemed_count + 1 >= max_redemptions then 'used' else status end,
         updated_at = now()
   where id = c.id;
  return jsonb_build_object('credits', c.credits, 'source', c.source, 'codeId', c.id, 'from', c.gift_from_user);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Counter top-ups (cash or payment taken by staff in person)
-- ---------------------------------------------------------------------------
alter table manual_topup_requests add column if not exists source text not null default 'qr';
alter table manual_topup_requests add column if not exists payment_method text;
-- 'gift': the payment buys a gift card (credit_codes row, pending until paid) instead of wallet credits.
alter table manual_topup_requests add column if not exists purpose text not null default 'wallet';
alter table manual_topup_requests add column if not exists gift_code_id uuid references credit_codes(id) on delete set null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'manual_topups_source_check') then
    alter table manual_topup_requests add constraint manual_topups_source_check check (source in ('qr','counter'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'manual_topups_purpose_check') then
    alter table manual_topup_requests add constraint manual_topups_purpose_check check (purpose in ('wallet','gift') and (purpose = 'wallet' or gift_code_id is not null));
  end if;
end $$;
create index if not exists manual_topups_counter_idx on manual_topup_requests (decided_by, decided_at desc) where source = 'counter';

-- Deliver what a confirmed payment bought: wallet credits, or (purpose 'gift') make the gift card usable.
create or replace function topup_fulfil(p_request uuid, p_key text, p_memo text)
returns void language plpgsql as $$
declare r manual_topup_requests; w wallets;
begin
  select * into r from manual_topup_requests where id = p_request;
  if r.purpose = 'gift' then
    update credit_codes set status = 'active', updated_at = now() where id = r.gift_code_id and status = 'pending';
    return;
  end if;
  w := wallet_lock(r.user_id);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (r.user_id, 'topup', r.credits, 'manual_topup', r.id::text, p_key, p_memo);
  update wallets set posted_balance_credits = posted_balance_credits + r.credits, version = version + 1, updated_at = now()
    where user_id = r.user_id;
end $$;

-- Same rules as before (0006); the credit step now goes through topup_fulfil.
create or replace function approve_manual_topup(p_request uuid, p_admin uuid, p_bank_ref text, p_notes text)
returns boolean language plpgsql as $$
declare r manual_topup_requests; a users;
begin
  select * into a from users where id = p_admin;
  if not found or a.role not in ('admin','super_admin','finance') or a.status <> 'active' then
    raise exception 'only an active admin or finance reviewer can approve top-ups';
  end if;
  if p_bank_ref is null or length(trim(p_bank_ref)) < 4 then
    raise exception 'verified bank/merchant transaction reference is required';
  end if;
  select * into r from manual_topup_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;
  if r.status = 'approved' then return false; end if;
  if r.status <> 'pending' then raise exception 'request is %, only pending requests can be approved', r.status; end if;
  if r.user_id = p_admin then raise exception 'admins cannot approve their own top-up; another admin must approve it'; end if;
  update manual_topup_requests
     set status = 'approved', verified_bank_ref = trim(p_bank_ref), decided_by = p_admin, decided_at = now(), decision_notes = p_notes
   where id = r.id;
  perform topup_fulfil(r.id, 'manual-topup:' || r.id::text, case when r.purpose = 'gift' then 'Gift card ' else 'QR top-up ' end || r.reference);
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (p_admin, 'web', 'wallet.manual_topup_approved', 'manual_topup', r.id::text,
            jsonb_build_object('credits', r.credits, 'amount_paisa', r.amount_paisa, 'reference', r.reference, 'bank_ref', trim(p_bank_ref), 'purpose', r.purpose));
  return true;
end $$;

create or replace function confirm_gateway_topup(p_request uuid, p_trace text)
returns boolean language plpgsql as $$
declare r manual_topup_requests; k text;
begin
  if p_trace is null or length(trim(p_trace)) < 3 then raise exception 'gateway trace id is required'; end if;
  select * into r from manual_topup_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;
  if r.status = 'approved' then return false; end if;
  if r.qr_mode <> 'dynamic' then raise exception 'only dynamic QR requests can be gateway-confirmed'; end if;
  if r.status not in ('awaiting_payment','pending') then raise exception 'request is %', r.status; end if;
  k := 'manual-topup:' || r.id::text;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return false; end if;
  update manual_topup_requests
     set status = 'approved', verified_bank_ref = 'FONEPAY:' || trim(p_trace), decided_at = now(),
         decision_notes = 'Confirmed automatically by Fonepay', submitted_at = coalesce(submitted_at, now())
   where id = r.id;
  perform topup_fulfil(r.id, k, case when r.purpose = 'gift' then 'Gift card ' else 'Fonepay QR ' end || r.reference);
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (null, 'system', 'wallet.gateway_topup_confirmed', 'manual_topup', r.id::text,
            jsonb_build_object('credits', r.credits, 'amount_paisa', r.amount_paisa, 'reference', r.reference, 'trace', trim(p_trace), 'purpose', r.purpose));
  return true;
end $$;

create or replace function reject_manual_topup(p_request uuid, p_admin uuid, p_notes text)
returns boolean language plpgsql as $$
declare r manual_topup_requests; a users;
begin
  select * into a from users where id = p_admin;
  if not found or a.role not in ('admin','super_admin','finance') then raise exception 'only an admin or finance reviewer can reject top-ups'; end if;
  if p_notes is null or length(trim(p_notes)) < 3 then raise exception 'a rejection reason is required'; end if;
  select * into r from manual_topup_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;
  if r.status = 'rejected' then return false; end if;
  if r.status not in ('pending','awaiting_payment') then raise exception 'request is %', r.status; end if;
  update manual_topup_requests set status = 'rejected', decided_by = p_admin, decided_at = now(), decision_notes = p_notes where id = r.id;
  if r.purpose = 'gift' then
    update credit_codes set status = 'cancelled', updated_at = now() where id = r.gift_code_id and status = 'pending';
  end if;
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (p_admin, 'web', 'wallet.manual_topup_rejected', 'manual_topup', r.id::text, jsonb_build_object('reason', p_notes));
  return true;
end $$;

-- Counter: staff took cash / a payment in person. Credits the customer's wallet
-- (p_gift_code null) or sells a gift card (p_gift_code = the pending code made by the app).
create or replace function counter_topup(p_admin uuid, p_user uuid, p_npr bigint, p_credits bigint, p_method text, p_receipt text,
                                         p_note text, p_reference text, p_key text, p_daily_limit_npr bigint, p_gift_code uuid)
returns uuid language plpgsql as $$
declare a users; u users; k text; rid uuid; today_npr bigint;
begin
  select * into a from users where id = p_admin;
  if not found or a.role not in ('super_admin','admin','finance','counter') or a.status <> 'active' then
    raise exception 'only counter staff can add counter top-ups';
  end if;
  if p_gift_code is null and p_user = p_admin then raise exception 'staff cannot top up their own wallet'; end if;
  select * into u from users where id = p_user;
  if not found or u.status <> 'active' then raise exception 'customer not found'; end if;
  k := 'counter-topup:' || p_admin::text || ':' || p_key;
  select id into rid from manual_topup_requests where source = 'counter' and decided_by = p_admin and payer_txn_ref = k;
  if found then return rid; end if;
  if p_npr <= 0 or p_credits <= 0 then raise exception 'amount must be positive'; end if;
  if a.role <> 'super_admin' and p_daily_limit_npr > 0 then
    -- Serialize per staff member so two tabs cannot both pass the limit.
    perform pg_advisory_xact_lock(hashtext('counter:' || p_admin::text));
    select coalesce(sum(amount_paisa), 0) / 100 into today_npr from manual_topup_requests
     where source = 'counter' and decided_by = p_admin and status = 'approved'
       and decided_at >= (date_trunc('day', now() at time zone 'Asia/Kathmandu') at time zone 'Asia/Kathmandu');
    if today_npr + p_npr > p_daily_limit_npr then raise exception 'daily counter limit of NPR % reached', p_daily_limit_npr; end if;
  end if;
  insert into manual_topup_requests (user_id, reference, amount_paisa, credits, status, submitted_at, payer_txn_ref, verified_bank_ref,
                                     decided_by, decided_at, decision_notes, source, payment_method, purpose, gift_code_id)
    values (p_user, p_reference, p_npr * 100, p_credits, 'approved', now(), k, coalesce(nullif(trim(p_receipt), ''), p_reference),
            p_admin, now(), nullif(trim(p_note), ''), 'counter', p_method,
            case when p_gift_code is null then 'wallet' else 'gift' end, p_gift_code)
    returning id into rid;
  perform topup_fulfil(rid, k, case when p_gift_code is null then 'Counter top-up ' else 'Gift card ' end || p_reference || ' (' || p_method || ')');
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (p_admin, 'web', case when p_gift_code is null then 'wallet.counter_topup' else 'wallet.counter_gift_sold' end, 'manual_topup', rid::text,
            jsonb_build_object('user', p_user, 'npr', p_npr, 'credits', p_credits, 'method', p_method, 'reference', p_reference, 'receipt', nullif(trim(p_receipt), '')));
  return rid;
end $$;
