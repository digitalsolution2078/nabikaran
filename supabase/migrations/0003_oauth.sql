-- Phase 1: OAuth 2.1 authorization server for MCP clients. Additive only.
-- Tokens and codes are stored as SHA-256 hashes; the plaintext exists only in
-- the response to the client.

create table if not exists oauth_clients (
  id                         text primary key,                 -- public client_id (nb_...)
  name                       text not null,
  redirect_uris              text[] not null,
  token_endpoint_auth_method text not null default 'none' check (token_endpoint_auth_method in ('none','client_secret_post')),
  client_secret_hash         text,
  client_uri                 text,
  logo_uri                   text,
  software_id                text,
  registration_ip_hash       text,
  created_at                 timestamptz not null default now(),
  disabled_at                timestamptz                      -- admin kill-switch
);

create table if not exists oauth_authorization_codes (
  code_hash      text primary key,
  client_id      text not null references oauth_clients(id) on delete cascade,
  user_id        uuid not null references users(id) on delete cascade,
  redirect_uri   text not null,
  scopes         text[] not null,
  code_challenge text not null,                                -- S256 only
  resource       text not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists oauth_codes_expires_idx on oauth_authorization_codes(expires_at);

create table if not exists oauth_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  client_id    text not null references oauth_clients(id) on delete cascade,
  kind         text not null check (kind in ('access','refresh')),
  token_hash   text not null unique,
  family_id    uuid not null,                                   -- refresh-token rotation family
  scopes       text[] not null,
  resource     text not null,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  revoke_reason text,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists oauth_tokens_user_client_idx on oauth_tokens(user_id, client_id, kind, revoked_at);
create index if not exists oauth_tokens_family_idx on oauth_tokens(family_id);
create index if not exists oauth_tokens_expires_idx on oauth_tokens(expires_at);

-- Two-step prepare/confirm snapshots for MCP tools (used from Phase 3).
create table if not exists prepared_actions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  client_id       text references oauth_clients(id) on delete set null,
  kind            text not null check (kind in ('create_reminder','update_reminder','cancel_reminder')),
  input           jsonb not null,
  preview         jsonb not null,
  pricing_version bigint references pricing_versions(id),
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  result_ref      text,
  created_at      timestamptz not null default now()
);
create index if not exists prepared_actions_user_idx on prepared_actions(user_id, created_at desc);

alter table oauth_clients enable row level security;
alter table oauth_authorization_codes enable row level security;
alter table oauth_tokens enable row level security;
alter table prepared_actions enable row level security;
