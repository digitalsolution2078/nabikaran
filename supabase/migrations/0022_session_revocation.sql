-- 0022: "Log out all devices". A session cookie issued before
-- users.sessions_valid_after is no longer accepted. Additive, re-runnable.
alter table users add column if not exists sessions_valid_after timestamptz;
