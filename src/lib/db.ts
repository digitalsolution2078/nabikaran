/**
 * Minimal SQL client abstraction.
 *
 * Production: node-postgres Pool against Supabase's Postgres (service role /
 * direct connection string). Tests: PGlite (in-process Postgres) implements
 * the same `query(sql, params)` shape, so wallet/dispatch logic runs against
 * the real migration without a server.
 */
import { Pool, type PoolClient } from "pg";
import { env } from "./env";

export interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount?: number | null;
}

export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>>;
  /** Run fn inside a transaction. Nested calls are not supported. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

class PgDb implements Db {
  constructor(private readonly pool: Pool) {}
  query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.pool.query(sql, params) as unknown as Promise<QueryResultLike<R>>;
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const res = await fn(new PgClientDb(client));
      await client.query("commit");
      return res;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

class PgClientDb implements Db {
  constructor(private readonly client: PoolClient) {}
  query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.client.query(sql, params) as unknown as Promise<QueryResultLike<R>>;
  }
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** Wrap any object exposing `query(sql, params)` (e.g. PGlite) as a Db. */
export function wrapQueryable(q: {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>>;
  transaction?<T>(fn: (tx: { query<R>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>> }) => Promise<T>): Promise<T>;
}): Db {
  const db: Db = {
    query: (sql, params = []) => q.query(sql, params),
    tx: async (fn) => {
      if (q.transaction) {
        return q.transaction((t) => fn(wrapQueryable({ query: (s, p) => t.query(s, p) })));
      }
      await q.query("begin");
      try {
        const r = await fn(db);
        await q.query("commit");
        return r;
      } catch (e) {
        await q.query("rollback");
        throw e;
      }
    },
  };
  return db;
}

let pool: Pool | undefined;
let override: Db | undefined;

/** Tests inject a PGlite-backed Db here. */
export function setDbForTests(db: Db | undefined) {
  override = db;
}

export function getDb(): Db {
  if (override) return override;
  if (!pool) {
    if (!env.databaseUrl) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: env.databaseUrl, max: 10 });
  }
  return new PgDb(pool);
}
