/**
 * Schema steps the app can apply by itself at start-up when they are missing.
 * Production (/docker/nabikaran) has no migrate step we control, so additive,
 * re-runnable migrations are embedded here and applied once. Each SQL string is
 * an exact copy of its supabase/migrations file (a test keeps them in sync).
 *
 * GENERATED from supabase/migrations by copying the file contents. Do not edit by hand.
 */
export interface EnsureStep {
  name: string;
  /** Returns one row with ok=true when the step is already in place. */
  check: string;
  sql: string;
}

export const ENSURE_STEPS: EnsureStep[] = [
  {
    name: "0007_groups_yearly",
    check:
      "select (to_regclass('public.reminder_groups') is not null and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'renewal_items' and column_name = 'repeat_anchor') and exists (select 1 from document_templates where slug = 'birthday')) as ok",
    sql: "-- 0007: reminder groups (e.g. \"Birthdays\"), yearly repeating reminders and\n-- occasion categories (birthday, anniversary, event). Additive only.\n--\n-- Reminders in a group still go ONLY to the owner's own verified phone; a\n-- birthday reminder tells the owner about a friend's birthday, it never\n-- messages the friend.\n\ncreate table if not exists reminder_groups (\n  id             uuid primary key default gen_random_uuid(),\n  owner_user_id  uuid not null references users(id) on delete cascade,\n  name           text not null check (char_length(btrim(name)) between 1 and 40),\n  kind           text not null default 'custom' check (kind in ('custom','birthday','anniversary')),\n  created_at     timestamptz not null default now(),\n  updated_at     timestamptz not null default now()\n);\ncreate unique index if not exists reminder_groups_owner_name_idx on reminder_groups (owner_user_id, lower(btrim(name)));\ncreate index if not exists reminder_groups_owner_idx on reminder_groups (owner_user_id);\n\nalter table renewal_items add column if not exists group_id uuid references reminder_groups(id) on delete set null;\nalter table renewal_items add column if not exists repeat_yearly boolean not null default false;\n-- Month and day the reminder repeats on, in the calendar it was entered in (\"MM-DD\").\n-- Kept separately so a 29 Feb or a BS day 32 survives years where it is clamped.\nalter table renewal_items add column if not exists repeat_anchor text check (repeat_anchor is null or repeat_anchor ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[0-2])$');\ncreate index if not exists renewal_items_group_idx on renewal_items (group_id) where group_id is not null;\ncreate index if not exists renewal_items_yearly_idx on renewal_items (expiry_at_utc) where repeat_yearly and status = 'active';\n\n-- Occasion templates in the \"Add reminder\" picker.\ndo $$\ndeclare c record;\nbegin\n  for c in select conname from pg_constraint\n            where conrelid = 'document_templates'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'group_key'\n  loop\n    execute format('alter table document_templates drop constraint %I', c.conname);\n  end loop;\n  alter table document_templates add constraint document_templates_group_key_check\n    check (group_key in ('vehicle','personal','insurance','business','custom','occasions'));\nend $$;\n\ninsert into document_templates (slug, group_key, category, name_en, name_ne, sms_label, description_en, description_ne, default_offsets, popular, sort_order) values\n  ('birthday','occasions','birthday','Birthday','जन्मदिन','Birthday',\n   'Get an SMS before a friend''s or family member''s birthday, every year. The SMS comes to your own number. Enter the name in English letters so it fits the SMS.',\n   'साथी वा परिवारको जन्मदिन अघि हरेक वर्ष SMS पाउनुहोस्। SMS तपाईंकै नम्बरमा आउँछ। नाम अंग्रेजी अक्षरमा लेख्नुहोस्।',\n   '{1440,0}', false, 900),\n  ('anniversary','occasions','anniversary','Anniversary','वार्षिकोत्सव','Anniversary',\n   'Wedding or other anniversaries, reminded every year on your own number.',\n   'विवाह वा अन्य वार्षिकोत्सव, हरेक वर्ष तपाईंकै नम्बरमा सम्झना।',\n   '{10080,1440,0}', false, 910),\n  ('event','occasions','event','Event or occasion','कार्यक्रम','Event',\n   'Any date you do not want to miss: a puja, a party, a payment or an appointment.',\n   'नछुटाउनुपर्ने कुनै पनि मिति: पूजा, पार्टी, भुक्तानी वा भेटघाट।',\n   '{1440,0}', false, 920)\non conflict (slug) do nothing;\n",
  },
  {
    name: "0008_seo_pages",
    check:
      "select to_regclass('public.seo_pages') is not null as ok",
    sql: "-- 0008: SEO landing pages editable from the admin panel. Additive, re-runnable.\n-- Built-in pages live in code (src/lib/seo-pages.ts); a row here overrides a\n-- built-in page with the same slug (edit or hide it) or adds a new page.\n\ncreate table if not exists seo_pages (\n  slug          text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),\n  template      text,\n  title         text not null check (char_length(title) between 10 and 120),\n  description   text not null check (char_length(description) between 30 and 300),\n  h1            text not null check (char_length(h1) between 5 and 120),\n  intro         text not null check (char_length(intro) <= 1200),\n  nepali        text not null default '' check (char_length(nepali) <= 1200),\n  remind_what   text[] not null default '{}',\n  schedule      text not null default '' check (char_length(schedule) <= 600),\n  faqs          jsonb not null default '[]'::jsonb,\n  published     boolean not null default true,\n  sort_order    int not null default 100,\n  updated_by    uuid references users(id) on delete set null,\n  updated_at    timestamptz not null default now()\n);\n",
  },
];
