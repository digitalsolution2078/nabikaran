-- 0019: Credits with two decimals. 1 credit is still NPR 1, but prices can
-- now be fractional (e.g. SMS 1.50, WhatsApp 1.00, email 0.30 credits per
-- message). Every credit amount becomes numeric(14,2): exact decimal maths,
-- no floating point and no rounding inside the wallet. Re-runnable.
--
-- Wallet functions declared their credit parameters and variables as bigint,
-- which would round 1.5 to 2. Each public function that uses bigint is
-- re-created from its own current definition with numeric instead (all bigint
-- use in this schema's functions is for credits or rupees).

do $$
declare
  col record;
  fn record;
  fns oid[];
  def text;
  f oid;
begin
  for col in
    select * from (values
      ('wallets','posted_balance_credits'), ('wallets','reserved_credits'),
      ('wallet_ledger','signed_credits'), ('credit_reservations','held_credits'),
      ('reminder_jobs','estimated_credits'), ('wallet_adjustment_requests','signed_credits'),
      ('payment_orders','credits'), ('manual_topup_requests','credits'), ('topup_packs','credits'),
      ('referral_rewards','referrer_credits'), ('referral_rewards','referee_credits'),
      ('user_plans','price_credits'), ('credit_code_batches','credits'), ('credit_codes','credits'),
      ('credit_code_redemptions','credits')
    ) v(t, c)
  loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = col.t and column_name = col.c and data_type <> 'numeric') then
      execute format('alter table %I alter column %I type numeric(14,2) using %I::numeric(14,2)', col.t, col.c, col.c);
    end if;
  end loop;

  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'pricing_versions' and column_name = 'credits_per_billable_unit' and data_type <> 'numeric') then
    alter table pricing_versions alter column credits_per_billable_unit type numeric(10,2) using credits_per_billable_unit::numeric(10,2);
  end if;

  select array_agg(p.oid) into fns
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~* '\mbigint\M';
  foreach f in array coalesce(fns, '{}'::oid[]) loop
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as res, pg_get_functiondef(p.oid) as d
      into fn from pg_proc p where p.oid = f;
    def := regexp_replace(fn.d, '\mbigint\M', 'numeric', 'gi');
    -- A changed argument or result type is a different function: drop the old one first.
    if fn.args ~* '\mbigint\M' or fn.res ~* '\mbigint\M' then
      execute format('drop function public.%I(%s)', fn.proname, fn.args);
    end if;
    execute def;
  end loop;
end $$;

-- Default prices per message (admin can change them in Admin → Channels & pricing).
insert into pricing_versions (credits_per_billable_unit, pricing_policy, channel)
select v.price, '{"note":"decimal credits (0019)"}'::jsonb, v.channel
  from (values ('sms', 1.50::numeric), ('whatsapp', 1.00::numeric), ('email', 0.30::numeric)) v(channel, price)
 where not exists (select 1 from pricing_versions p where p.channel = v.channel and p.pricing_policy->>'note' = 'decimal credits (0019)');
