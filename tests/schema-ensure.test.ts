import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestDb } from "./helpers/db";
import type { Db } from "@/lib/db";
import { ENSURE_STEPS } from "@/lib/schema-steps";
import { ensureSchema, schemaStatus } from "@/lib/schema-ensure";

let db: Db;
let close: () => Promise<void> = async () => undefined;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

describe("embedded schema steps", () => {
  it("are exact copies of their migration files", () => {
    for (const s of ENSURE_STEPS) {
      const file = readFileSync(path.resolve(__dirname, `../supabase/migrations/${s.name}.sql`), "utf8");
      expect(s.sql).toBe(file);
    }
  });

  it("report present and do nothing on a fully migrated database", async () => {
    expect(await schemaStatus(db)).toEqual({ "0007_groups_yearly": true, "0008_seo_pages": true, "0009_referrals_pin": true, "0010_web_push": true, "0011_pro": true, "0012_calendar": true, "0013_credit_codes": true, "0014_user_bans": true, "0015_security": true, "0016_totp": true, "0017_push_channel": true, "0018_support": true, "0019_decimal_credits": true, "0020_topup_bonus": true, "0021_pro_monthly_credits": true, "0022_session_revocation": true });
    expect(await ensureSchema(db)).toEqual({ applied: [], present: ["0007_groups_yearly", "0008_seo_pages", "0009_referrals_pin", "0010_web_push", "0011_pro", "0012_calendar", "0013_credit_codes", "0014_user_bans", "0015_security", "0016_totp", "0017_push_channel", "0018_support", "0019_decimal_credits", "0020_topup_bonus", "0021_pro_monthly_credits", "0022_session_revocation"] });
  });

  it("report missing when the step is not in place", async () => {
    await db.query("alter table renewal_items rename column repeat_anchor to repeat_anchor_tmp");
    expect(await schemaStatus(db)).toMatchObject({ "0007_groups_yearly": false });
    await db.query("alter table renewal_items rename column repeat_anchor_tmp to repeat_anchor");
  });
});
