-- 0020: Top-up bonus tiers. A bigger top-up earns bonus credits (e.g. NPR 1,000
-- → +5%). Tiers live in a table the admin edits; the bonus is fixed when the
-- top-up request or payment order is created (what the customer was shown) and
-- posted as its own 'bonus' ledger line, so revenue and promotion stay
-- separate in reports. Applies to wallet top-ups only (QR, payment gateways,
-- counter), never to gift cards. Additive, re-runnable.

do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'wallet_ledger'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'type'
  loop
    execute format('alter table wallet_ledger drop constraint %I', c.conname);
  end loop;
  alter table wallet_ledger add constraint wallet_ledger_type_check
    check (type in ('topup','debit','reversal','adjustment','fee','referral','plan','coupon','gift','bonus'));
end $$;

create table if not exists topup_bonus_tiers (
  min_npr    int primary key check (min_npr between 1 and 1000000),
  percent    numeric(5,2) not null check (percent > 0 and percent <= 100),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into topup_bonus_tiers (min_npr, percent)
select v.min_npr, v.percent from (values (500, 3.00), (1000, 5.00), (2500, 8.00), (5000, 10.00)) v(min_npr, percent)
 where not exists (select 1 from topup_bonus_tiers);

-- Bonus credits for a top-up of p_npr rupees: the highest tier it reaches, two decimals.
create or replace function topup_bonus_credits(p_npr numeric) returns numeric language sql stable as $$
  select coalesce((select round(p_npr * t.percent / 100, 2) from topup_bonus_tiers t where t.min_npr <= p_npr order by t.min_npr desc limit 1), 0)
$$;

alter table manual_topup_requests add column if not exists bonus_credits numeric(14,2) not null default 0;
alter table payment_orders add column if not exists bonus_credits numeric(14,2) not null default 0;

create or replace function manual_topup_set_bonus() returns trigger language plpgsql as $$
begin
  new.bonus_credits := case when new.purpose = 'gift' then 0 else topup_bonus_credits(new.amount_paisa / 100.0) end;
  return new;
end $$;
create or replace function payment_order_set_bonus() returns trigger language plpgsql as $$
begin
  new.bonus_credits := topup_bonus_credits(new.amount_paisa / 100.0);
  return new;
end $$;
drop trigger if exists manual_topup_requests_bonus on manual_topup_requests;
create trigger manual_topup_requests_bonus before insert on manual_topup_requests for each row execute function manual_topup_set_bonus();
drop trigger if exists payment_orders_bonus on payment_orders;
create trigger payment_orders_bonus before insert on payment_orders for each row execute function payment_order_set_bonus();

-- Credit a paid request (QR, Fonepay, counter): the top-up, then its bonus.
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
  if r.bonus_credits > 0 then
    insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
      values (r.user_id, 'bonus', r.bonus_credits, 'manual_topup', r.id::text, p_key || ':bonus', 'Top-up bonus');
  end if;
  update wallets set posted_balance_credits = posted_balance_credits + r.credits + r.bonus_credits, version = version + 1, updated_at = now()
    where user_id = r.user_id;
end $$;

-- Gateway payment (Khalti, eSewa…): the top-up, then its bonus.
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
  if o.bonus_credits > 0 then
    insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
      values (o.user_id, 'bonus', o.bonus_credits, 'payment_order', o.id::text, k || ':bonus', 'Top-up bonus');
  end if;
  update wallets set posted_balance_credits = posted_balance_credits + o.credits + o.bonus_credits,
                     version = version + 1, updated_at = now()
    where user_id = o.user_id;
  update payment_orders set status = 'paid', paid_at = coalesce(paid_at, now()),
                            verified_transaction_id = coalesce(verified_transaction_id, p_verified_transaction_id),
                            updated_at = now()
    where id = o.id;
  return true;
end $$;

-- A refunded payment takes back the top-up and its bonus (never below zero; the shortfall is returned).
create or replace function wallet_reverse_topup(p_order_id uuid, p_reason text)
returns numeric language plpgsql as $$
declare o payment_orders; k text; w wallets; avail numeric; take numeric; total numeric;
begin
  select * into o from payment_orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  k := 'topup-reversal:' || o.id::text;
  if exists (select 1 from wallet_ledger where idempotency_key = k) then return 0; end if;
  w := wallet_lock(o.user_id);
  total := o.credits + o.bonus_credits;
  avail := w.posted_balance_credits - w.reserved_credits;
  take := greatest(0, least(avail, total));
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (o.user_id, 'reversal', -take, 'payment_order', o.id::text, k, p_reason);
  update wallets set posted_balance_credits = posted_balance_credits - take,
                     version = version + 1, updated_at = now() where user_id = o.user_id;
  update payment_orders set status = 'refunded', updated_at = now() where id = o.id;
  return total - take;
end $$;
