-- 0021: Pro gives flexible credits every month instead of fixed SMS/WhatsApp/
-- email counts. Each plan month gets user_plans.monthly_credits (a snapshot
-- of the offer when bought) as a 'pro_credit' ledger line; whatever of it is
-- not spent by the end of that month is taken back as 'pro_expiry' (Pro
-- credits are used before paid credits, and expiry never goes below zero
-- or touches credits held for scheduled messages). Additive, re-runnable.

do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'wallet_ledger'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'type'
  loop
    execute format('alter table wallet_ledger drop constraint %I', c.conname);
  end loop;
  alter table wallet_ledger add constraint wallet_ledger_type_check
    check (type in ('topup','debit','reversal','adjustment','fee','referral','plan','coupon','gift','bonus','pro_credit','pro_expiry'));
end $$;

alter table user_plans add column if not exists monthly_credits numeric(14,2) not null default 0;

create table if not exists pro_credit_grants (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  user_plan_id    uuid not null references user_plans(id) on delete cascade,
  period_no       int not null check (period_no >= 0),
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  credits         numeric(14,2) not null check (credits > 0),
  expired_credits numeric(14,2) not null default 0,
  expired_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_plan_id, period_no),
  check (period_end > period_start)
);
create index if not exists pro_credit_grants_open_idx on pro_credit_grants (period_end) where expired_at is null;

-- Grant one plan month's credits, exactly once.
create or replace function pro_grant_monthly(p_plan uuid, p_period int, p_start timestamptz, p_end timestamptz)
returns boolean language plpgsql as $$
declare p user_plans; w wallets; gid uuid;
begin
  select * into p from user_plans where id = p_plan for update;
  if not found or p.status <> 'active' or p.kind not in ('paid','grant') or p.monthly_credits <= 0 then return false; end if;
  insert into pro_credit_grants (user_id, user_plan_id, period_no, period_start, period_end, credits)
    values (p.user_id, p.id, p_period, p_start, p_end, p.monthly_credits)
    on conflict (user_plan_id, period_no) do nothing
    returning id into gid;
  if gid is null then return false; end if;
  w := wallet_lock(p.user_id);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (p.user_id, 'pro_credit', p.monthly_credits, 'pro_credit_grant', gid::text, 'pro-credit:' || gid::text, 'Nabikaran Pro monthly credits');
  update wallets set posted_balance_credits = posted_balance_credits + p.monthly_credits, version = version + 1, updated_at = now()
    where user_id = p.user_id;
  return true;
end $$;

-- End of a plan month: take back what of the grant was not spent on messages.
create or replace function pro_expire_grant(p_grant uuid) returns numeric language plpgsql as $$
declare g pro_credit_grants; w wallets; spent numeric; unused numeric; take numeric;
begin
  select * into g from pro_credit_grants where id = p_grant for update;
  if not found or g.expired_at is not null then return 0; end if;
  w := wallet_lock(g.user_id);
  select coalesce(-sum(signed_credits), 0) into spent from wallet_ledger
   where user_id = g.user_id and reference_type = 'reminder_job' and type in ('debit','reversal')
     and created_at >= g.period_start and created_at < g.period_end;
  unused := greatest(0, g.credits - greatest(spent, 0));
  take := least(unused, greatest(0, w.posted_balance_credits - w.reserved_credits));
  if take > 0 then
    insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
      values (g.user_id, 'pro_expiry', -take, 'pro_credit_grant', g.id::text, 'pro-expiry:' || g.id::text, 'Unused Pro monthly credits');
    update wallets set posted_balance_credits = posted_balance_credits - take, version = version + 1, updated_at = now()
      where user_id = g.user_id;
  end if;
  update pro_credit_grants set expired_credits = take, expired_at = now() where id = g.id;
  return take;
end $$;

-- The Pro offer switches from fixed message counts to 30 credits a month (admin can change it).
update app_settings
   set value = value || '{"allowance_sms":0,"allowance_whatsapp":0,"allowance_email":0,"monthly_credits":30}'::jsonb
 where key = 'pro' and not (value ? 'monthly_credits');
