-- 0008: SEO landing pages editable from the admin panel. Additive, re-runnable.
-- Built-in pages live in code (src/lib/seo-pages.ts); a row here overrides a
-- built-in page with the same slug (edit or hide it) or adds a new page.

create table if not exists seo_pages (
  slug          text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  template      text,
  title         text not null check (char_length(title) between 10 and 120),
  description   text not null check (char_length(description) between 30 and 300),
  h1            text not null check (char_length(h1) between 5 and 120),
  intro         text not null check (char_length(intro) <= 1200),
  nepali        text not null default '' check (char_length(nepali) <= 1200),
  remind_what   text[] not null default '{}',
  schedule      text not null default '' check (char_length(schedule) <= 600),
  faqs          jsonb not null default '[]'::jsonb,
  published     boolean not null default true,
  sort_order    int not null default 100,
  updated_by    uuid references users(id) on delete set null,
  updated_at    timestamptz not null default now()
);
