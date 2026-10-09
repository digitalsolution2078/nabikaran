import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { createTestDb } from "./helpers/db";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

test("staging disables seeded merchant QR and WhatsApp, repeatably", async () => {
  const ctx = await createTestDb();
  close = ctx.close;
  const sql = readFileSync(new URL("../deploy/staging-settings.sql", import.meta.url), "utf8");
  await ctx.pg.exec("update app_settings set value = jsonb_set(value, '{enabled}', 'true'::jsonb) where key in ('manual_qr', 'whatsapp')");
  await ctx.pg.exec(sql);
  await ctx.pg.exec(sql);
  const { rows } = await ctx.db.query<{ key: string; enabled: boolean }>("select key, (value->>'enabled')::boolean as enabled from app_settings where key in ('manual_qr', 'whatsapp') order by key");
  expect(rows).toEqual([{ key: "manual_qr", enabled: false }, { key: "whatsapp", enabled: false }]);
});
