-- 0005: sign-in SMS fee with negative balance (debt), usage lock below a
-- floor, and Fonepay dynamic QR auto-confirmation. Additive; no data reset.

-- ---------------------------------------------------------------------------
-- 1. Wallets may go negative, but ONLY through the sign-in fee. Every other
--    debit path (reservations, adjustments, reversals) still refuses to spend
--    money the user does not have. A later top-up offsets the debt.
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'wallets'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ~ 'posted_balance_credits'
  loop
    execute format('alter table wallets drop constraint %I', c.conname);
  end loop;
  for c in
    select conname from pg_constraint
     where conrelid = 'wallet_ledger'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ~ 'type'
  loop
    execute format('alter table wallet_ledger drop constraint %I', c.conname);
  end loop;
end $$;
alter table wallet_ledger add constraint wallet_ledger_type_check
  check (type in ('topup','debit','reversal','adjustment','fee'));

-- Replaces the dropped CHECKs: an update may never push the AVAILABLE balance
-- (posted - reserved) further below zero, unless it runs inside
-- wallet_charge_signin_fee, which sets a transaction-local flag.
create or replace function wallets_guard_debt() returns trigger language plpgsql as $$
begin
  if (new.posted_balance_credits - new.reserved_credits) < 0
     and (new.posted_balance_credits - new.reserved_credits) < (old.posted_balance_credits - old.reserved_credits)
     and coalesce(current_setting('nabikaran.allow_debt', true), '') <> 'on' then
    raise exception 'wallet available balance cannot go below zero (only the sign-in fee may create debt)';
  end if;
  return new;
end $$;
drop trigger if exists wallets_guard_debt on wallets;
create trigger wallets_guard_debt before update on wallets
  for each row execute function wallets_guard_debt();

-- Reversing a top-up never takes more than is available, and never "takes" a
-- negative amount when the wallet is already in debt.
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
  take := greatest(0, least(avail, o.credits));
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (o.user_id, 'reversal', -take, 'payment_order', o.id::text, k, p_reason);
  update wallets set posted_balance_credits = posted_balance_credits - take,
                     version = version + 1, updated_at = now() where user_id = o.user_id;
  update payment_orders set status = 'refunded', updated_at = now() where id = o.id;
  return o.credits - take;
end $$;

-- A reservation already holds the job's credits; a sign-in fee taken after the
-- hold must not shrink what the job is charged.
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

-- ---------------------------------------------------------------------------
-- 2. Sign-in fee: charged once per successful OTP sign-in (keyed by the
--    verification row), even when it takes the balance below zero.
-- ---------------------------------------------------------------------------
insert into app_settings (key, value) values
  ('signin', '{"fee_credits": 1, "min_balance": -5, "charge_staff": false}'::jsonb)
on conflict (key) do nothing;

create or replace function wallet_charge_signin_fee(p_user uuid, p_verification uuid, p_fee bigint)
returns boolean language plpgsql as $$
declare k text; w wallets;
begin
  if p_fee is null or p_fee <= 0 then return false; end if;
  k := 'signin-fee:' || p_verification::text;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return false; end if;
  w := wallet_lock(p_user);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (p_user, 'fee', -p_fee, 'phone_verification', p_verification::text, k, 'Sign-in SMS');
  perform set_config('nabikaran.allow_debt', 'on', true);
  update wallets set posted_balance_credits = posted_balance_credits - p_fee,
                     version = version + 1, updated_at = now() where user_id = p_user;
  perform set_config('nabikaran.allow_debt', 'off', true);
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Fonepay dynamic QR: the payment gateway confirms the payment, so credits
--    are issued without an admin. Shares the ledger key with admin approval,
--    so a request can never be credited twice by the two paths.
-- ---------------------------------------------------------------------------
alter table manual_topup_requests add column if not exists qr_mode text not null default 'static';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'manual_topups_qr_mode_check') then
    alter table manual_topup_requests add constraint manual_topups_qr_mode_check check (qr_mode in ('static','dynamic'));
  end if;
end $$;
alter table manual_topup_requests add column if not exists qr_payload text;
alter table manual_topup_requests add column if not exists gateway_checked_at timestamptz;

create or replace function confirm_gateway_topup(p_request uuid, p_trace text)
returns boolean language plpgsql as $$
declare r manual_topup_requests; k text; w wallets; ref text;
begin
  if p_trace is null or length(trim(p_trace)) < 3 then raise exception 'gateway trace id is required'; end if;
  select * into r from manual_topup_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;
  if r.status = 'approved' then return false; end if;
  if r.qr_mode <> 'dynamic' then raise exception 'only dynamic QR requests can be gateway-confirmed'; end if;
  if r.status not in ('awaiting_payment','pending') then raise exception 'request is %', r.status; end if;
  k := 'manual-topup:' || r.id::text;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return false; end if;
  ref := 'FONEPAY:' || trim(p_trace);
  w := wallet_lock(r.user_id);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (r.user_id, 'topup', r.credits, 'manual_topup', r.id::text, k, 'Fonepay QR ' || r.reference);
  update wallets set posted_balance_credits = posted_balance_credits + r.credits, version = version + 1, updated_at = now()
    where user_id = r.user_id;
  update manual_topup_requests
     set status = 'approved', verified_bank_ref = ref, decided_at = now(),
         decision_notes = 'Confirmed automatically by Fonepay', submitted_at = coalesce(submitted_at, now())
   where id = r.id;
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (null, 'system', 'wallet.gateway_topup_confirmed', 'manual_topup', r.id::text,
            jsonb_build_object('credits', r.credits, 'amount_paisa', r.amount_paisa, 'reference', r.reference, 'trace', trim(p_trace)));
  return true;
end $$;
