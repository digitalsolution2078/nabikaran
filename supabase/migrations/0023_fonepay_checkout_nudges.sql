-- 0023: "Checkout by Fonepay" as an online payment gateway next to Khalti and
-- eSewa, and the opt-out for "set your first reminder" nudges. Additive, re-runnable.

-- 1. Payment orders may now come from Fonepay checkout.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'payment_orders'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\(gateway = ANY'
  loop
    execute format('alter table payment_orders drop constraint %I', c.conname);
  end loop;
  alter table payment_orders add constraint payment_orders_gateway_check check (gateway in ('khalti','esewa','fonepay','mock'));
end $$;

-- 2. Customers can turn off the "set your first reminder" nudges (Settings).
alter table users add column if not exists nudges_opt_out boolean not null default false;
