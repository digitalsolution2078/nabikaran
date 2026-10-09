import { getDb, type Db } from "../db";
import { audit } from "../core/audit";
import { HttpError } from "../core/errors";
import { setSetting } from "./settings";
import { validateWaTemplate } from "../whatsapp/templates";

const actorP = (id: string) => ({ userId: id, via: "web" as const, scopes: [], locale: "en" });

/** Non-secret WhatsApp settings (tokens/app secret stay in the server environment). */
export async function saveWhatsappSettings(actorId: string, value: unknown, db: Db = getDb()) {
  const saved = await setSetting({ id: actorId }, "whatsapp", value, db);
  await audit(db, actorP(actorId), "whatsapp.settings.update", { type: "app_setting", id: "whatsapp" }, saved);
  return saved;
}

export async function listWaTemplates(db: Db = getDb()) {
  const { rows } = await db.query<{ id: number; locale: string; category: string; meta_name: string; meta_language: string; body_preview: string; version: number; active: boolean; created_at: unknown }>(
    "select id, locale, category, meta_name, meta_language, body_preview, version, active, created_at from whatsapp_templates order by active desc, locale, category, version desc",
  );
  return rows.map((r) => ({ ...r, created_at: new Date(String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at)).toISOString() }));
}

/** New version of the Meta template mapping for a locale/category; the previous one is kept, inactive. */
export async function saveWaTemplate(
  actorId: string,
  t: { locale: "en-NP" | "ne-NP"; category: "default" | "today"; meta_name: string; meta_language: string; body_preview: string },
  db: Db = getDb(),
) {
  const err = validateWaTemplate(t);
  if (err) throw new HttpError(400, err, "invalid_template");
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ v: number }>("select coalesce(max(version),0) + 1 as v from whatsapp_templates where locale = $1 and category = $2", [t.locale, t.category]);
    await tx.query("update whatsapp_templates set active = false where locale = $1 and category = $2 and active", [t.locale, t.category]);
    await tx.query(
      "insert into whatsapp_templates (locale, category, meta_name, meta_language, body_preview, version, active, created_by) values ($1,$2,$3,$4,$5,$6,true,$7)",
      [t.locale, t.category, t.meta_name, t.meta_language, t.body_preview, rows[0].v, actorId],
    );
    await audit(tx, actorP(actorId), "whatsapp.template.update", { type: "whatsapp_template", id: `${t.locale}/${t.category}` }, { version: rows[0].v, meta_name: t.meta_name, meta_language: t.meta_language });
    return rows[0].v;
  });
}
