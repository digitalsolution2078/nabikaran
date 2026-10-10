import { z } from "zod";
import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { SEO_PAGES, type SeoPage } from "../seo-pages";

export type SeoSource = "built-in" | "edited" | "custom";
export interface ManagedSeoPage extends SeoPage {
  published: boolean;
  sortOrder: number;
  source: SeoSource;
  updatedAt: string | null;
}

interface Row {
  slug: string; template: string | null; title: string; description: string; h1: string; intro: string; nepali: string;
  remind_what: string[]; schedule: string; faqs: Array<{ q: string; a: string }>; published: boolean; sort_order: number; updated_at: unknown;
}

const BUILT_IN = new Map(SEO_PAGES.map((p, i) => [p.slug, { page: p, sort: (i + 1) * 10 }]));

function fromRow(r: Row): ManagedSeoPage {
  return {
    slug: r.slug, template: r.template, title: r.title, description: r.description, h1: r.h1, intro: r.intro, nepali: r.nepali,
    remindWhat: r.remind_what ?? [], schedule: r.schedule, faqs: Array.isArray(r.faqs) ? r.faqs : [],
    published: r.published, sortOrder: r.sort_order, source: BUILT_IN.has(r.slug) ? "edited" : "custom",
    updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
  };
}

/**
 * Built-in pages from code, overridden or extended by admin rows. Falls back to
 * the built-in pages if the database is unavailable, so SEO pages never 500.
 */
export async function listSeoPages(opts: { includeHidden?: boolean } = {}, db: Db = getDb()): Promise<ManagedSeoPage[]> {
  let rows: Row[] = [];
  try {
    rows = (await db.query<Row>("select * from seo_pages")).rows;
  } catch {
    rows = [];
  }
  const out = new Map<string, ManagedSeoPage>();
  for (const [slug, { page, sort }] of BUILT_IN) out.set(slug, { ...page, published: true, sortOrder: sort, source: "built-in", updatedAt: null });
  for (const r of rows) out.set(r.slug, fromRow(r));
  return [...out.values()].filter((p) => opts.includeHidden || p.published).sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));
}

export async function getSeoPage(slug: string, db: Db = getDb()): Promise<ManagedSeoPage | null> {
  return (await listSeoPages({}, db)).find((p) => p.slug === slug) ?? null;
}

export const seoInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80),
  template: z.string().max(60).nullable(),
  title: z.string().trim().min(10).max(120),
  description: z.string().trim().min(30).max(300),
  h1: z.string().trim().min(5).max(120),
  intro: z.string().trim().min(1).max(1200),
  nepali: z.string().trim().max(1200),
  remindWhat: z.array(z.string().trim().min(1).max(120)).max(12),
  schedule: z.string().trim().max(600),
  faqs: z.array(z.object({ q: z.string().trim().min(3).max(200), a: z.string().trim().min(3).max(800) })).max(15),
  published: z.boolean(),
  sortOrder: z.number().int().min(0).max(10000),
});
export type SeoInput = z.infer<typeof seoInputSchema>;

/** Same rule as document templates: never state official validity periods or deadlines as fact. */
const VALIDITY_CLAIM = /\b(is valid for|valid for \d|validity (is|of) \d|must be renewed every|expires (after|every) \d|renew(ed)? every \d+ (year|month))/i;
const OVERPROMISE = /\b(guarantee(d)? delivery|100% delivery|government (database|record)s? (check|lookup)|we renew|we will renew)\b/i;

export function checkSeoHonesty(p: SeoInput): string | null {
  const text = [p.title, p.description, p.h1, p.intro, p.schedule, ...p.remindWhat, ...p.faqs.flatMap((f) => [f.q, f.a])].join("\n");
  if (VALIDITY_CLAIM.test(text)) return "Do not state official validity periods or deadlines as fact. Ask readers to use the date on their own document and confirm with the issuing office.";
  if (OVERPROMISE.test(text)) return "Nabikaran is a reminder service: do not promise guaranteed delivery, government record checks or renewing documents.";
  return null;
}

export async function saveSeoPage(actorId: string, input: SeoInput, db: Db = getDb()): Promise<ManagedSeoPage> {
  const p = seoInputSchema.parse(input);
  const honesty = checkSeoHonesty(p);
  if (honesty) throw new HttpError(400, honesty, "invalid_seo_page");
  if (p.template) {
    const { rows } = await db.query("select 1 from document_templates where slug = $1", [p.template]);
    if (!rows[0]) throw new HttpError(400, `Unknown reminder template "${p.template}"`, "invalid_seo_page");
  }
  await db.tx(async (tx) => {
    await tx.query(
      `insert into seo_pages (slug, template, title, description, h1, intro, nepali, remind_what, schedule, faqs, published, sort_order, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13, now())
       on conflict (slug) do update set template = excluded.template, title = excluded.title, description = excluded.description, h1 = excluded.h1,
         intro = excluded.intro, nepali = excluded.nepali, remind_what = excluded.remind_what, schedule = excluded.schedule, faqs = excluded.faqs,
         published = excluded.published, sort_order = excluded.sort_order, updated_by = excluded.updated_by, updated_at = now()`,
      [p.slug, p.template, p.title, p.description, p.h1, p.intro, p.nepali, p.remindWhat, p.schedule, JSON.stringify(p.faqs), p.published, p.sortOrder, actorId],
    );
    await tx.query("insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted) values ($1,'web','seo.page_saved','seo_page',$2,$3)", [
      actorId, p.slug, JSON.stringify({ published: p.published, builtIn: BUILT_IN.has(p.slug) }),
    ]);
  });
  return (await listSeoPages({ includeHidden: true }, db)).find((x) => x.slug === p.slug)!;
}

/** Built-in page: back to the code version. Custom page: deleted. */
export async function resetSeoPage(actorId: string, slug: string, db: Db = getDb()): Promise<void> {
  await db.tx(async (tx) => {
    const { rows } = await tx.query("delete from seo_pages where slug = $1 returning slug", [slug]);
    if (!rows[0]) throw new HttpError(404, "Nothing to reset", "not_found");
    await tx.query("insert into audit_events (actor_user_id, actor_via, action, target_type, target_id) values ($1,'web','seo.page_reset','seo_page',$2)", [actorId, slug]);
  });
}
