-- 0015: Pre-launch security hardening. Additive, re-runnable.

-- 1. Codes: staff can never redeem a coupon or gift card (an admin or counter
--    staff member could otherwise mint codes or "sell" a gift card without taking
--    money and credit themselves), and nobody can redeem a code they created.
create or replace function credit_code_redeem(p_user uuid, p_hash text)
returns jsonb language plpgsql as $$
declare c credit_codes; bstatus text; w wallets; k text; t text; r text;
begin
  select role into r from users where id = p_user;
  if r is distinct from 'user' then raise exception 'code_staff'; end if;
  select * into c from credit_codes where code_hash = p_hash for update;
  if not found or c.status in ('pending','disabled','cancelled') then raise exception 'code_invalid'; end if;
  if c.created_by = p_user and c.source = 'admin' then raise exception 'code_invalid'; end if;
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

-- 2. One bank / wallet transaction can fund only one approved top-up, however the
--    reference is typed ("FT 123" = "ft123") and whether Fonepay confirmed it
--    ("FONEPAY:123") or an admin typed it. Skipped (with a notice) if old data
--    already has duplicates, so start-up never fails; the exact-match index stays.
do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'manual_topups_bank_ref_norm_unique') then
    begin
      create unique index manual_topups_bank_ref_norm_unique on manual_topup_requests
        (upper(regexp_replace(regexp_replace(verified_bank_ref, '^FONEPAY:', '', 'i'), '[^A-Za-z0-9]', '', 'g')))
        where status = 'approved' and verified_bank_ref is not null;
    exception when unique_violation then
      raise notice 'manual_topups_bank_ref_norm_unique not created: existing duplicate references';
    end;
  end if;
  -- 3. A gateway payment reference (Khalti pidx) belongs to exactly one order.
  if not exists (select 1 from pg_indexes where indexname = 'payment_orders_gateway_ref_unique') then
    begin
      create unique index payment_orders_gateway_ref_unique on payment_orders (gateway, gateway_ref) where gateway_ref is not null;
    exception when unique_violation then
      raise notice 'payment_orders_gateway_ref_unique not created: existing duplicates';
    end;
  end if;
end $$;
