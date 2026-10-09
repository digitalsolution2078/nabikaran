-- 0006: delivery channels (SMS + WhatsApp), channel pricing, WhatsApp
-- templates/webhooks, separated staff roles, admin notes, template versions.
-- Additive; existing reminders keep working as SMS-only.

-- ---------------------------------------------------------------------------
-- 1. Staff roles
-- ---------------------------------------------------------------------------
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('user','admin','super_admin','finance','support','content','auditor'));

-- WhatsApp consent (business-initiated messages need the user's opt-in).
alter table users add column if not exists whatsapp_opt_in_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Channels on reminders and jobs
-- ---------------------------------------------------------------------------
alter table renewal_items add column if not exists channels text[] not null default '{sms}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'renewal_items_channels_check') then
    alter table renewal_items add constraint renewal_items_channels_check
      check (cardinality(channels) between 1 and 2 and channels <@ array['sms','whatsapp']::text[]);
  end if;
end $$;

alter table reminder_jobs add column if not exists channel text not null default 'sms';
do $$
declare c record;
begin
  if not exists (select 1 from pg_constraint where conname = 'reminder_jobs_channel_check') then
    alter table reminder_jobs add constraint reminder_jobs_channel_check check (channel in ('sms','whatsapp'));
  end if;
  -- one job per (renewal, rule, cycle) becomes one job per channel
  for c in select conname from pg_constraint
            where conrelid = 'reminder_jobs'::regclass and contype = 'u'
              and pg_get_constraintdef(oid) = 'UNIQUE (renewal_id, rule_id, cycle_no)'
  loop
    execute format('alter table reminder_jobs drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'reminder_jobs_rule_cycle_channel_key') then
    alter table reminder_jobs add constraint reminder_jobs_rule_cycle_channel_key unique (renewal_id, rule_id, cycle_no, channel);
  end if;
  -- WhatsApp reports "read"
  for c in select conname from pg_constraint
            where conrelid = 'reminder_jobs'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'awaiting_credits'
  loop
    execute format('alter table reminder_jobs drop constraint %I', c.conname);
  end loop;
end $$;
alter table reminder_jobs add constraint reminder_jobs_status_check check (status in
  ('planned','awaiting_credits','scheduled','sending','submitted','delivered','read','failed','unknown','cancelled'));
create index if not exists reminder_jobs_channel_idx on reminder_jobs(channel, status);

-- Attempts table now carries both channels.
alter table sms_attempts add column if not exists channel text not null default 'sms';
alter table sms_attempts add column if not exists delivered_at timestamptz;
alter table sms_attempts add column if not exists read_at timestamptz;
alter table sms_attempts add column if not exists refunded_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Channel pricing (each channel has its own version history)
-- ---------------------------------------------------------------------------
alter table pricing_versions add column if not exists channel text not null default 'sms';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pricing_versions_channel_check') then
    alter table pricing_versions add constraint pricing_versions_channel_check check (channel in ('sms','whatsapp'));
  end if;
end $$;
insert into pricing_versions (credits_per_billable_unit, pricing_policy, channel)
select 3, '{"note":"provisional: set from your Meta WhatsApp rate card before enabling"}'::jsonb, 'whatsapp'
where not exists (select 1 from pricing_versions where channel = 'whatsapp');

-- ---------------------------------------------------------------------------
-- 4. WhatsApp (Meta Cloud API) templates, settings and webhook log.
--    Access tokens / app secret / verify token live ONLY in the server env.
-- ---------------------------------------------------------------------------
create table if not exists whatsapp_templates (
  id            bigint generated always as identity primary key,
  locale        text not null check (locale in ('en-NP','ne-NP')),
  category      text not null check (category in ('default','today')),
  meta_name     text not null,                 -- approved template name in Meta
  meta_language text not null,                 -- e.g. en, ne
  body_preview  text not null,                 -- what Meta shows, with {{1}} label, {{2}} days, {{3}} date
  version       int not null default 1,
  active        boolean not null default true,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now()
);
create unique index if not exists whatsapp_templates_active_unique on whatsapp_templates (locale, category) where active;
insert into whatsapp_templates (locale, category, meta_name, meta_language, body_preview)
select * from (values
  ('en-NP','default','nabikaran_renewal_reminder','en','Nabikaran reminder: your {{1}} expires in {{2}} day(s) on {{3}}. Please renew it on time.'),
  ('en-NP','today','nabikaran_renewal_due_today','en','Nabikaran reminder: your {{1}} expires today ({{3}}). Please renew it on time.'),
  ('ne-NP','default','nabikaran_renewal_reminder','ne','Nabikaran सम्झना: तपाईंको {{1}} को म्याद {{2}} दिनपछि ({{3}}) सकिँदैछ। समयमै नवीकरण गर्नुहोस्।'),
  ('ne-NP','today','nabikaran_renewal_due_today','ne','Nabikaran सम्झना: तपाईंको {{1}} को म्याद आज ({{3}}) सकिँदैछ। समयमै नवीकरण गर्नुहोस्।')
) v(locale, category, meta_name, meta_language, body_preview)
where not exists (select 1 from whatsapp_templates);

insert into app_settings (key, value) values
  ('whatsapp', '{"enabled": false, "phone_number_id": "", "business_account_id": "", "template_namespace": "", "default_language": "en"}'::jsonb)
on conflict (key) do nothing;

create table if not exists whatsapp_webhook_events (
  id                  bigint generated always as identity primary key,
  received_at         timestamptz not null default now(),
  signature_valid     boolean not null,
  kind                text not null,            -- status | message | verify | other
  provider_message_id text,
  status              text,
  error_code          text,
  payload_redacted    jsonb
);
create index if not exists whatsapp_webhook_events_msg_idx on whatsapp_webhook_events (provider_message_id);
create index if not exists whatsapp_webhook_events_time_idx on whatsapp_webhook_events (received_at desc);

-- ---------------------------------------------------------------------------
-- 5. Manual top-up decisions: finance reviewers may decide too.
-- ---------------------------------------------------------------------------
create or replace function approve_manual_topup(p_request uuid, p_admin uuid, p_bank_ref text, p_notes text)
returns boolean language plpgsql as $$
declare r manual_topup_requests; a users; k text; w wallets;
begin
  select * into a from users where id = p_admin;
  if not found or a.role not in ('admin','super_admin','finance') or a.status <> 'active' then
    raise exception 'only an active admin or finance reviewer can approve top-ups';
  end if;
  if p_bank_ref is null or length(trim(p_bank_ref)) < 4 then
    raise exception 'verified bank/merchant transaction reference is required';
  end if;
  select * into r from manual_topup_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;
  k := 'manual-topup:' || r.id::text;
  if r.status = 'approved' then return false; end if;
  if r.status <> 'pending' then raise exception 'request is %, only pending requests can be approved', r.status; end if;
  if r.user_id = p_admin then raise exception 'admins cannot approve their own top-up; another admin must approve it'; end if;
  w := wallet_lock(r.user_id);
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (r.user_id, 'topup', r.credits, 'manual_topup', r.id::text, k, 'QR top-up ' || r.reference);
  update wallets set posted_balance_credits = posted_balance_credits + r.credits, version = version + 1, updated_at = now()
    where user_id = r.user_id;
  update manual_topup_requests
     set status = 'approved', verified_bank_ref = trim(p_bank_ref), decided_by = p_admin, decided_at = now(), decision_notes = p_notes
   where id = r.id;
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (p_admin, 'web', 'wallet.manual_topup_approved', 'manual_topup', r.id::text,
            jsonb_build_object('credits', r.credits, 'amount_paisa', r.amount_paisa, 'reference', r.reference, 'bank_ref', trim(p_bank_ref)));
  return true;
end $$;

create or replace function reject_manual_topup(p_request uuid, p_admin uuid, p_notes text)
returns boolean language plpgsql as $$
declare r manual_topup_requests; a users;
begin
  select * into a from users where id = p_admin;
  if not found or a.role not in ('admin','super_admin','finance') then raise exception 'only an admin or finance reviewer can reject top-ups'; end if;
  if p_notes is null or length(trim(p_notes)) < 3 then raise exception 'a rejection reason is required'; end if;
  select * into r from manual_topup_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;
  if r.status = 'rejected' then return false; end if;
  if r.status not in ('pending','awaiting_payment') then raise exception 'request is %', r.status; end if;
  update manual_topup_requests set status = 'rejected', decided_by = p_admin, decided_at = now(), decision_notes = p_notes where id = r.id;
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (p_admin, 'web', 'wallet.manual_topup_rejected', 'manual_topup', r.id::text, jsonb_build_object('reason', p_notes));
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Support notes on users (append-only, like the audit log)
-- ---------------------------------------------------------------------------
create table if not exists admin_notes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references users(id) on delete cascade,
  author_id  uuid not null references users(id),
  body       text not null check (length(trim(body)) between 2 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists admin_notes_user_idx on admin_notes (user_id, created_at desc);
drop trigger if exists admin_notes_no_update on admin_notes;
create trigger admin_notes_no_update before update or delete on admin_notes
  for each row execute function audit_events_append_only();

-- ---------------------------------------------------------------------------
-- 7. Document templates: publish flag, channel mapping, version history
-- ---------------------------------------------------------------------------
alter table document_templates add column if not exists published boolean not null default true;
alter table document_templates add column if not exists version int not null default 1;
alter table document_templates add column if not exists default_channels text[] not null default '{sms}';
create table if not exists document_template_versions (
  id         bigint generated always as identity primary key,
  slug       text not null,
  version    int not null,
  snapshot   jsonb not null,
  changed_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (slug, version)
);
insert into document_template_versions (slug, version, snapshot)
select slug, version, to_jsonb(t) - 'created_at' from document_templates t
on conflict do nothing;

-- Descriptions: always tell users to use their own document and confirm with the issuing office.
update document_templates
   set description_en = description_en || ' Enter the expiry date printed on your own document and confirm renewal rules with the issuing office.'
 where description_en not like '%issuing office%';
update document_templates
   set description_ne = description_ne || ' आफ्नै कागजातमा लेखिएको म्याद राख्नुहोस् र नवीकरणका नियम सम्बन्धित कार्यालयमा पुष्टि गर्नुहोस्।'
 where description_ne not like '%सम्बन्धित कार्यालय%';

alter table whatsapp_templates enable row level security;
alter table whatsapp_webhook_events enable row level security;
alter table admin_notes enable row level security;
alter table document_template_versions enable row level security;
