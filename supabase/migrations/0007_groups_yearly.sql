-- 0007: reminder groups (e.g. "Birthdays"), yearly repeating reminders and
-- occasion categories (birthday, anniversary, event). Additive only.
--
-- Reminders in a group still go ONLY to the owner's own verified phone; a
-- birthday reminder tells the owner about a friend's birthday, it never
-- messages the friend.

create table if not exists reminder_groups (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references users(id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 40),
  kind           text not null default 'custom' check (kind in ('custom','birthday','anniversary')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists reminder_groups_owner_name_idx on reminder_groups (owner_user_id, lower(btrim(name)));
create index if not exists reminder_groups_owner_idx on reminder_groups (owner_user_id);

alter table renewal_items add column if not exists group_id uuid references reminder_groups(id) on delete set null;
alter table renewal_items add column if not exists repeat_yearly boolean not null default false;
-- Month and day the reminder repeats on, in the calendar it was entered in ("MM-DD").
-- Kept separately so a 29 Feb or a BS day 32 survives years where it is clamped.
alter table renewal_items add column if not exists repeat_anchor text check (repeat_anchor is null or repeat_anchor ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[0-2])$');
create index if not exists renewal_items_group_idx on renewal_items (group_id) where group_id is not null;
create index if not exists renewal_items_yearly_idx on renewal_items (expiry_at_utc) where repeat_yearly and status = 'active';

-- Occasion templates in the "Add reminder" picker.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'document_templates'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'group_key'
  loop
    execute format('alter table document_templates drop constraint %I', c.conname);
  end loop;
  alter table document_templates add constraint document_templates_group_key_check
    check (group_key in ('vehicle','personal','insurance','business','custom','occasions'));
end $$;

insert into document_templates (slug, group_key, category, name_en, name_ne, sms_label, description_en, description_ne, default_offsets, popular, sort_order) values
  ('birthday','occasions','birthday','Birthday','जन्मदिन','Birthday',
   'Get an SMS before a friend''s or family member''s birthday, every year. The SMS comes to your own number. Enter the name in English letters so it fits the SMS.',
   'साथी वा परिवारको जन्मदिन अघि हरेक वर्ष SMS पाउनुहोस्। SMS तपाईंकै नम्बरमा आउँछ। नाम अंग्रेजी अक्षरमा लेख्नुहोस्।',
   '{1440,0}', false, 900),
  ('anniversary','occasions','anniversary','Anniversary','वार्षिकोत्सव','Anniversary',
   'Wedding or other anniversaries, reminded every year on your own number.',
   'विवाह वा अन्य वार्षिकोत्सव, हरेक वर्ष तपाईंकै नम्बरमा सम्झना।',
   '{10080,1440,0}', false, 910),
  ('event','occasions','event','Event or occasion','कार्यक्रम','Event',
   'Any date you do not want to miss: a puja, a party, a payment or an appointment.',
   'नछुटाउनुपर्ने कुनै पनि मिति: पूजा, पार्टी, भुक्तानी वा भेटघाट।',
   '{1440,0}', false, 920)
on conflict (slug) do nothing;
