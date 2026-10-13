-- 0018: Support tickets. Customers (signed in) and visitors (guest, with a
-- private link) open tickets from the website; staff answer from Admin →
-- Support. Additive, re-runnable.

create table if not exists support_tickets (
  id                uuid primary key default gen_random_uuid(),
  number            bigint generated always as identity,
  user_id           uuid references users(id) on delete set null,
  guest_name        text,
  guest_phone       text,
  guest_email       text,
  -- sha256 of the guest's private link token (null for signed-in customers)
  access_token_hash text unique,
  category          text not null check (category in ('payment','reminder','account','pro','other')),
  subject           text not null check (char_length(subject) between 3 and 140),
  status            text not null default 'open' check (status in ('open','waiting_customer','resolved','closed')),
  priority          text not null default 'normal' check (priority in ('normal','high')),
  assigned_to       uuid references users(id) on delete set null,
  last_customer_at  timestamptz not null default now(),
  last_staff_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (user_id is not null or access_token_hash is not null)
);
create unique index if not exists support_tickets_number_idx on support_tickets (number);
create index if not exists support_tickets_user_idx on support_tickets (user_id, created_at desc);
create index if not exists support_tickets_status_idx on support_tickets (status, last_customer_at desc);

create table if not exists support_messages (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references support_tickets(id) on delete cascade,
  author_user_id uuid references users(id) on delete set null,
  author_kind    text not null check (author_kind in ('customer','staff','system')),
  body           text not null check (char_length(body) between 1 and 5000),
  -- staff-only note, never shown to the customer
  internal       boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists support_messages_ticket_idx on support_messages (ticket_id, created_at);

-- One optional screenshot or PDF per message (max 3 MB, type checked by content).
create table if not exists support_attachments (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references support_messages(id) on delete cascade,
  content_type text not null check (content_type in ('image/png','image/jpeg','image/webp','application/pdf')),
  size_bytes   int not null check (size_bytes between 1 and 3145728),
  bytes        bytea not null,
  created_at   timestamptz not null default now()
);
create index if not exists support_attachments_message_idx on support_attachments (message_id);
