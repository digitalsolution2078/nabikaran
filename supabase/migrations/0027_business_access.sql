-- 0027: Business tools need an admin's approval. Accounts already using them
-- keep access. Additive, re-runnable.
alter table users add column if not exists business_allowed boolean not null default false;
update users set business_allowed = true where business_name is not null and not business_allowed;
