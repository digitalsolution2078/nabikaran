-- 0004: roles + bootstrap, user preferences, app settings, manual (QR) top-ups,
-- direct super-admin adjustments, GSM-7 SMS templates, document templates,
-- immutable audit log. Additive; no existing data is removed.

-- ---------------------------------------------------------------------------
-- Roles and preferences
-- ---------------------------------------------------------------------------
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('user','admin','super_admin'));

alter table users
  add column if not exists email        text,
  add column if not exists ui_language  text not null default 'ne' check (ui_language in ('ne','en')),
  add column if not exists date_format  text not null default 'BS' check (date_format in ('BS','AD'));
create unique index if not exists users_email_unique on users (lower(email)) where email is not null;
create index if not exists users_display_name_idx on users (lower(display_name));

-- One-time, server-side bootstrap of the first Super Admin. It can only be run
-- by someone with database access (docker compose exec db psql ...), and it
-- refuses to run once any super_admin exists. Roles are never self-assignable
-- through the application.
create or replace function bootstrap_super_admin(p_phone text) returns text language plpgsql as $$
declare u users;
begin
  if exists (select 1 from users where role = 'super_admin') then
    raise exception 'a super_admin already exists; promote further admins from the admin dashboard';
  end if;
  select * into u from users where phone_e164 = p_phone for update;
  if not found then raise exception 'no user with phone % — sign in once with OTP first', p_phone; end if;
  if u.phone_verified_at is null or u.status <> 'active' then raise exception 'user must be active and phone-verified'; end if;
  update users set role = 'super_admin', updated_at = now() where id = u.id;
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (null, 'system', 'rbac.bootstrap_super_admin', 'user', u.id::text, '{}'::jsonb);
  return u.id::text;
end $$;

-- ---------------------------------------------------------------------------
-- Admin-managed settings (non-secret). Secrets stay in the environment.
-- ---------------------------------------------------------------------------
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
insert into app_settings (key, value) values
  ('topup', '{"min_npr": 20, "max_npr": 10000, "quick_amounts": [50, 100, 250, 500, 1000]}'::jsonb),
  ('manual_qr', '{"enabled": true, "image_path": "/payments/fonepay-qr.png", "network": "Fonepay", "merchant_name": "NARIKOT DIGITAL PRIVATE LIMITED", "terminal_id": "2222010021806804", "verified": false}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Manual QR top-ups: customer pays a static merchant QR, submits the
-- transaction reference, an admin verifies against bank/merchant records.
-- ---------------------------------------------------------------------------
create table if not exists manual_topup_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  reference         text not null unique,               -- shown to the customer, e.g. NB7K3Q9X
  amount_paisa      bigint not null check (amount_paisa > 0),
  credits           bigint not null check (credits > 0),
  status            text not null default 'awaiting_payment'
                      check (status in ('awaiting_payment','pending','approved','rejected','cancelled')),
  payer_txn_ref     text,                                -- what the customer typed
  payer_note        text,
  has_receipt       boolean not null default false,
  submitted_at      timestamptz,
  verified_bank_ref text,                                -- what the admin matched in bank/merchant records
  decided_by        uuid references users(id),
  decided_at        timestamptz,
  decision_notes    text,
  created_at        timestamptz not null default now()
);
create index if not exists manual_topups_status_idx on manual_topup_requests (status, submitted_at desc);
create index if not exists manual_topups_user_idx on manual_topup_requests (user_id, created_at desc);
-- One bank transaction can fund at most one approved request.
create unique index if not exists manual_topups_bank_ref_unique on manual_topup_requests (verified_bank_ref) where status = 'approved';

create table if not exists topup_receipts (
  request_id   uuid primary key references manual_topup_requests(id) on delete cascade,
  content_type text not null check (content_type in ('image/png','image/jpeg','image/webp','application/pdf')),
  size_bytes   int not null check (size_bytes > 0 and size_bytes <= 3145728),
  bytes        bytea not null,
  created_at   timestamptz not null default now()
);

-- Approve exactly once. Returns true if credits were issued now, false on replay.
create or replace function approve_manual_topup(p_request uuid, p_admin uuid, p_bank_ref text, p_notes text)
returns boolean language plpgsql as $$
declare r manual_topup_requests; a users; k text; w wallets;
begin
  select * into a from users where id = p_admin;
  if not found or a.role not in ('admin','super_admin') or a.status <> 'active' then
    raise exception 'only an active admin can approve top-ups';
  end if;
  if p_bank_ref is null or length(trim(p_bank_ref)) < 4 then
    raise exception 'verified bank/merchant transaction reference is required';
  end if;
  select * into r from manual_topup_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;
  k := 'manual-topup:' || r.id::text;
  if r.status = 'approved' then return false; end if;
  if r.status <> 'pending' then raise exception 'request is %, only pending requests can be approved', r.status; end if;
  if r.user_id = p_admin then raise exception 'admins cannot approve their own top-up'; end if;
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
  if not found or a.role not in ('admin','super_admin') then raise exception 'only an admin can reject top-ups'; end if;
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
-- Direct credit/debit by a Super Admin (single-person, mandatory reason,
-- idempotent by key). Ordinary admins still use the two-person request flow.
-- ---------------------------------------------------------------------------
alter table wallet_adjustment_requests add column if not exists direct boolean not null default false;

create or replace function wallet_direct_adjustment(p_user uuid, p_admin uuid, p_signed bigint, p_reason text, p_key text)
returns uuid language plpgsql as $$
declare a users; w wallets; req uuid; k text; avail bigint;
begin
  select * into a from users where id = p_admin;
  if not found or a.role <> 'super_admin' or a.status <> 'active' then raise exception 'only a super_admin can apply direct adjustments'; end if;
  if p_signed = 0 then raise exception 'amount must be non-zero'; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'a reason of at least 5 characters is required'; end if;
  if p_user = p_admin then raise exception 'admins cannot adjust their own wallet'; end if;
  k := 'adjustment-direct:' || p_key;
  select reference_id::uuid into req from wallet_ledger where idempotency_key = k;
  if found then return req; end if;
  w := wallet_lock(p_user);
  avail := w.posted_balance_credits - w.reserved_credits;
  if p_signed < 0 and -p_signed > avail then raise exception 'debit would exceed available balance (%)', avail; end if;
  insert into wallet_adjustment_requests (user_id, signed_credits, reason, requested_by, status, decided_at, direct)
    values (p_user, p_signed, trim(p_reason), p_admin, 'applied', now(), true) returning id into req;
  insert into wallet_ledger (user_id, type, signed_credits, reference_type, reference_id, idempotency_key, memo)
    values (p_user, 'adjustment', p_signed, 'wallet_adjustment_request', req::text, k, trim(p_reason));
  update wallets set posted_balance_credits = posted_balance_credits + p_signed, version = version + 1, updated_at = now() where user_id = p_user;
  insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted)
    values (p_admin, 'web', 'wallet.direct_adjustment', 'user', p_user::text, jsonb_build_object('credits', p_signed, 'reason', trim(p_reason), 'request', req));
  return req;
end $$;

-- ---------------------------------------------------------------------------
-- SMS templates: English and Romanized Nepali only (GSM-7, single segment).
-- locale 'en-NP' = English SMS, 'ne-NP' = Romanized Nepali SMS.
-- ---------------------------------------------------------------------------
update sms_templates set active = false where active;
insert into sms_templates (locale, category, template_version, body, active) values
  ('en-NP', 'default', 2, 'Nabikaran: Your {label} expires in {days} day(s) on {date}. Please renew on time.', true),
  ('en-NP', 'today',   2, 'Nabikaran: Your {label} expires today ({date}). Please renew on time.', true),
  ('ne-NP', 'default', 2, 'Nabikaran: Tapaiko {label} ko myad {days} din pachhi ({date}) sakinchha. Samayamai nabikaran garnuhos.', true),
  ('ne-NP', 'today',   2, 'Nabikaran: Tapaiko {label} ko myad aaja ({date}) sakinchha. Samayamai nabikaran garnuhos.', true)
on conflict (locale, category, template_version) do update set body = excluded.body, active = true;

-- ---------------------------------------------------------------------------
-- Document template library (admin-managed). Templates prefill data entry;
-- they never assert an official expiry date or validity period.
-- ---------------------------------------------------------------------------
create table if not exists document_templates (
  slug             text primary key,
  group_key        text not null check (group_key in ('vehicle','personal','insurance','business','custom')),
  category         text not null,
  name_en          text not null,
  name_ne          text not null,
  sms_label        text not null check (sms_label ~ '^[A-Za-z0-9 ./()&-]{1,30}$'),
  description_en   text not null default '',
  description_ne   text not null default '',
  default_offsets  int[] not null default '{43200,10080,1440,0}',
  popular          boolean not null default false,
  active           boolean not null default true,
  sort_order       int not null default 100,
  updated_by       uuid references users(id),
  updated_at       timestamptz not null default now()
);

insert into document_templates (slug, group_key, category, name_en, name_ne, sms_label, description_en, description_ne, default_offsets, popular, sort_order) values
  ('driving-licence','vehicle','licence','Driving Licence','सवारी चालक अनुमतिपत्र','Driving Licence',
   'Enter the expiry date printed on your licence card. Renewal is handled by the Department of Transport Management; check current requirements before you go.',
   'लाइसेन्स कार्डमा छापिएको म्याद सकिने मिति राख्नुहोस्। नवीकरण यातायात व्यवस्था विभाग मार्फत हुन्छ; जानु अघि हालको प्रक्रिया जाँच गर्नुहोस्।',
   '{43200,10080,1440,0}', true, 10),
  ('bluebook','vehicle','bluebook','Bluebook (Vehicle Registration)','ब्लुबुक (सवारी दर्ता)','Bluebook',
   'Enter the renewal date shown in your bluebook. Bluebook renewal, vehicle tax and insurance can be separate deadlines; add each one separately.',
   'ब्लुबुकमा देखिएको नवीकरण मिति राख्नुहोस्। ब्लुबुक, सवारी कर र बीमा फरक-फरक म्याद हुन सक्छन्; छुट्टाछुट्टै थप्नुहोस्।',
   '{43200,10080,1440,0}', true, 20),
  ('vehicle-tax','vehicle','vehicle_tax','Vehicle Tax','सवारी कर','Vehicle Tax',
   'Enter your vehicle tax due date. Tax deadlines and rates are set by the province; confirm with your Transport Management Office.',
   'सवारी कर तिर्नुपर्ने मिति राख्नुहोस्। कर र म्याद प्रदेश अनुसार फरक हुन्छ; यातायात व्यवस्था कार्यालयमा पुष्टि गर्नुहोस्।',
   '{43200,10080,1440}', true, 30),
  ('vehicle-insurance','vehicle','insurance','Vehicle Insurance','सवारी बीमा','Vehicle Insurance',
   'Enter the policy end date from your insurance certificate. Third-party insurance is required to drive legally.',
   'बीमा प्रमाणपत्रमा भएको अवधि सकिने मिति राख्नुहोस्।',
   '{43200,10080,1440,0}', true, 40),
  ('vehicle-permit','vehicle','vehicle_permit','Vehicle Route Permit / Fitness','रुट परमिट / जाँचपास','Vehicle Permit',
   'For commercial vehicles: enter the expiry on your route permit or fitness (jaanchpass) certificate.',
   'व्यावसायिक सवारीका लागि: रुट परमिट वा जाँचपास प्रमाणपत्रको म्याद राख्नुहोस्।',
   '{43200,10080,1440}', false, 50),
  ('passport','personal','passport','Passport','राहदानी','Passport',
   'Enter the expiry date from your passport. Many countries require at least six months of validity for travel, so remind yourself early.',
   'राहदानीमा भएको म्याद सकिने मिति राख्नुहोस्। धेरै देशमा यात्राका लागि कम्तीमा ६ महिना म्याद चाहिन्छ, त्यसैले चाँडै सम्झाउनुहोस्।',
   '{259200,129600,43200,10080}', true, 60),
  ('visa','personal','visa','Visa','भिसा','Visa',
   'Enter the expiry date on your visa or residence card.',
   'भिसा वा रेसिडेन्स कार्डमा भएको म्याद राख्नुहोस्।',
   '{86400,43200,10080,1440}', true, 70),
  ('work-permit','personal','work_permit','Work / Labour Permit','श्रम स्वीकृति / वर्क परमिट','Work Permit',
   'Enter the expiry of your labour approval (shram swikriti) or foreign work permit.',
   'श्रम स्वीकृति वा विदेशको वर्क परमिटको म्याद राख्नुहोस्।',
   '{86400,43200,10080,1440}', false, 80),
  ('other-id','personal','other','Other ID or Permit','अन्य परिचयपत्र वा अनुमति','ID/Permit',
   'Any identity document or permit that has an expiry date printed on it.',
   'म्याद छापिएको कुनै पनि परिचयपत्र वा अनुमतिपत्र।',
   '{43200,10080,1440}', false, 90),
  ('health-insurance','insurance','health_insurance','Health Insurance','स्वास्थ्य बीमा','Health Insurance',
   'Enter the renewal date of your health insurance policy (private insurer or Health Insurance Board).',
   'स्वास्थ्य बीमा नवीकरण मिति राख्नुहोस् (निजी बीमा कम्पनी वा स्वास्थ्य बीमा बोर्ड)।',
   '{43200,10080,1440}', true, 100),
  ('life-insurance','insurance','life_insurance','Life Insurance Premium','जीवन बीमा प्रिमियम','Life Insurance',
   'Enter the next premium due date shown on your policy schedule.',
   'बीमालेखमा देखिएको अर्को प्रिमियम तिर्ने मिति राख्नुहोस्।',
   '{43200,10080,1440}', false, 110),
  ('other-policy','insurance','insurance','Other Policy Renewal','अन्य बीमा नवीकरण','Policy',
   'Any other insurance or financial policy with a renewal date.',
   'नवीकरण मिति भएको अन्य बीमा वा वित्तीय नीति।',
   '{43200,10080,1440}', false, 120),
  ('tax-filing','business','tax_filing','PAN / VAT Filing Deadline','प्यान / भ्याट विवरण बुझाउने म्याद','Tax Filing',
   'Enter your next filing or payment deadline. Deadlines depend on your registration and the Inland Revenue Department calendar; confirm with IRD or your accountant.',
   'अर्को विवरण बुझाउने वा कर तिर्ने म्याद राख्नुहोस्। म्याद तपाईंको दर्ता र आन्तरिक राजस्व विभागको तालिका अनुसार हुन्छ; पुष्टि गर्नुहोस्।',
   '{10080,4320,1440}', true, 130),
  ('company-renewal','business','company','Company Registration / Renewal','कम्पनी / फर्म नवीकरण','Company Renewal',
   'Enter the renewal or annual return deadline for your company or firm registration.',
   'कम्पनी वा फर्म दर्ता नवीकरण वा वार्षिक विवरणको म्याद राख्नुहोस्।',
   '{43200,10080,1440}', false, 140),
  ('domain','business','domain','Domain Renewal','डोमेन नवीकरण','Domain',
   'Enter the domain expiry date from your registrar.',
   'डोमेन रजिस्ट्रारमा देखिएको म्याद राख्नुहोस्।',
   '{43200,10080,1440}', true, 150),
  ('hosting','business','hosting','Hosting / Server Renewal','होस्टिङ नवीकरण','Hosting',
   'Enter the next billing or expiry date of your hosting or VPS plan.',
   'होस्टिङ वा VPS को अर्को बिलिङ वा म्याद मिति राख्नुहोस्।',
   '{43200,10080,1440}', false, 160),
  ('software','business','subscription','Software Subscription','सफ्टवेयर सदस्यता','Subscription',
   'Any software or service subscription that renews or expires.',
   'नवीकरण हुने वा सकिने कुनै पनि सफ्टवेयर/सेवा सदस्यता।',
   '{10080,1440}', false, 170),
  ('contract','business','contract','Business Contract','व्यावसायिक सम्झौता','Contract',
   'Enter the end or renewal date of a contract, lease or agreement.',
   'सम्झौता, भाडा वा करारको सकिने वा नवीकरण मिति राख्नुहोस्।',
   '{86400,43200,10080}', false, 180),
  ('warranty','custom','warranty','Product Warranty','वारेन्टी','Warranty',
   'Enter the warranty end date from your bill or warranty card.',
   'बिल वा वारेन्टी कार्डमा भएको वारेन्टी सकिने मिति राख्नुहोस्।',
   '{43200,10080}', false, 190),
  ('custom','custom','other','Custom Reminder','आफ्नै रिमाइन्डर','Renewal',
   'Any personal or business date you want an SMS reminder for.',
   'SMS रिमाइन्डर चाहिने कुनै पनि व्यक्तिगत वा व्यावसायिक मिति।',
   '{10080,1440,0}', true, 999)
on conflict (slug) do nothing;

alter table renewal_items add column if not exists template_slug text references document_templates(slug) on delete set null;

-- ---------------------------------------------------------------------------
-- Audit log is append-only.
-- ---------------------------------------------------------------------------
create or replace function audit_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;
drop trigger if exists audit_events_no_update on audit_events;
create trigger audit_events_no_update before update or delete on audit_events
  for each row execute function audit_events_append_only();

alter table app_settings enable row level security;
alter table manual_topup_requests enable row level security;
alter table topup_receipts enable row level security;
alter table document_templates enable row level security;
