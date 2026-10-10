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
    expect(await schemaStatus(db)).toEqual({ "0007_groups_yearly": true });
    expect(await ensureSchema(db)).toEqual({ applied: [], present: ["0007_groups_yearly"] });
  });

  it("report missing when the step is not in place", async () => {
    await db.query("alter table renewal_items rename column repeat_anchor to repeat_anchor_tmp");
    expect(await schemaStatus(db)).toEqual({ "0007_groups_yearly": false });
    await db.query("alter table renewal_items rename column repeat_anchor_tmp to repeat_anchor");
  });
});
