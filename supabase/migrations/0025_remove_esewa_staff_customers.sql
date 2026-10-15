-- 0025: eSewa is removed as a payment method, and staff can add customer
-- accounts. Re-runnable.

-- eSewa: drop its stored secret key and admin settings, and cancel eSewa orders
-- that never completed (they can no longer be verified). Paid history is kept.
delete from app_secrets where key = 'esewa_secret_key';
update app_settings set value = value - 'esewa_mode' - 'esewa_product_code'
 where key = 'integrations' and (value ? 'esewa_mode' or value ? 'esewa_product_code');
update payment_orders set status = 'cancelled', updated_at = now()
 where gateway = 'esewa' and status in ('initiated','pending');

-- The staff member who created the account (null = the customer signed up).
alter table users add column if not exists created_by uuid references users(id) on delete set null;
