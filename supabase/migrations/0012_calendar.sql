-- 0012: Pro calendar feed (Google Calendar, Apple Calendar, Outlook). Additive, re-runnable.
-- A secret, revocable token in the feed URL; the feed is read-only.
alter table users add column if not exists calendar_token text;
create unique index if not exists users_calendar_token_idx on users (calendar_token) where calendar_token is not null;
alter table users add column if not exists calendar_token_at timestamptz;
