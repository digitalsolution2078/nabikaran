-- 0024: Business accounts. A dealer, insurance agent or consultancy keeps
-- reminders for its own clients: the reminder SMS goes to the client's phone
-- (with the business name), the business pays from its wallet and gets a free
-- app notification copy. Additive, re-runnable.

-- Business name shown in client SMS; set = business tools switched on.
alter table users add column if not exists business_name text;

create table if not exists clients (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  phone_e164    text not null check (phone_e164 ~ '^\+977[0-9]{10}$'),
  note          text check (note is null or char_length(note) <= 300),
  status        text not null default 'active' check (status in ('active','archived')),
  -- The business confirmed the client agreed to receive reminder SMS.
  consent_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists clients_owner_phone_active on clients (owner_user_id, phone_e164) where status = 'active';
create index if not exists clients_owner_idx on clients (owner_user_id, status, name);

-- A reminder can be for one of the owner's clients.
alter table renewal_items add column if not exists client_id uuid references clients(id) on delete set null;
create index if not exists renewal_items_client_idx on renewal_items (client_id) where client_id is not null;

-- Numbers that must never receive client reminders (complaints; set by admins).
create table if not exists blocked_recipients (
  phone_e164 text primary key,
  reason     text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
