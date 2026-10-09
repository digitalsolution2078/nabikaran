import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setDbForTests, wrapQueryable, type Db } from "@/lib/db";
import { webPrincipal, type Principal } from "@/lib/core/principal";

const migrationsDir = path.resolve(__dirname, "../../supabase/migrations");
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(path.join(migrationsDir, f), "utf8"));

/** Fresh in-process Postgres with every migration applied in order. */
export async function createTestDb(): Promise<{ db: Db; pg: PGlite; close: () => Promise<void> }> {
  const pg = new PGlite();
  // Supabase provides auth.uid(); stub it so RLS policies compile.
  await pg.exec("create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$;");
  for (const sql of migrations) await pg.exec(sql);
  const db = wrapQueryable({
    query: (sql, params) => pg.query(sql, params as unknown[]),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (s, p) => tx.query(s, p as unknown[]) })),
  });
  setDbForTests(db);
  return { db, pg, close: async () => { setDbForTests(undefined); await pg.close(); } };
}

export async function createUser(db: Db, phone = "+9779841000001", role: "user" | "admin" = "user"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into users (phone_e164, phone_verified_at, role) values ($1, now(), $2) returning id",
    [phone, role],
  );
  await db.query("insert into wallets (user_id) values ($1)", [rows[0].id]);
  return rows[0].id;
}

export function principalFor(userId: string, locale = "ne-NP"): Principal {
  return webPrincipal({ id: userId, locale });
}

export async function fund(db: Db, userId: string, credits: number, key = `test-topup-${Math.random()}`) {
  await db.query("insert into wallet_ledger (user_id, type, signed_credits, idempotency_key) values ($1,'topup',$2,$3)", [userId, credits, key]);
  await db.query("update wallets set posted_balance_credits = posted_balance_credits + $2 where user_id = $1", [userId, credits]);
}

export async function wallet(db: Db, userId: string) {
  const { rows } = await db.query<{ posted: string; reserved: string }>("select posted_balance_credits::text as posted, reserved_credits::text as reserved from wallets where user_id = $1", [userId]);
  return { posted: Number(rows[0].posted), reserved: Number(rows[0].reserved), available: Number(rows[0].posted) - Number(rows[0].reserved) };
}

export const inDays = (d: number, from = new Date()) => {
  const x = new Date(from.getTime() + d * 86_400_000);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
};
