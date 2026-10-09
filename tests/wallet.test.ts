import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let userId: string;

async function makeJob(credits: number, due = new Date(Date.now() + 3600_000)) {
  const { rows: r } = await db.query<{ id: string }>(
    "insert into renewal_items (owner_user_id, category, label, expiry_at_utc) values ($1,'other','x',$2) returning id",
    [userId, due.toISOString()],
  );
  const { rows: rule } = await db.query<{ id: string }>("insert into reminder_rules (renewal_id, offset_minutes) values ($1, $2) returning id", [r[0].id, Math.floor(Math.random() * 1e6)]);
  const { rows: job } = await db.query<{ id: string }>(
    "insert into reminder_jobs (renewal_id, rule_id, user_id, cycle_no, due_at_utc, estimated_credits) values ($1,$2,$3,1,$4,$5) returning id",
    [r[0].id, rule[0].id, userId, due.toISOString(), credits],
  );
  return job[0].id;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  userId = await createUser(db);
});
afterAll(() => close());

describe("wallet SQL invariants", () => {
  it("ledger is append-only", async () => {
    await fund(db, userId, 10, "k1");
    await expect(db.query("update wallet_ledger set signed_credits = 999 where idempotency_key = 'k1'")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from wallet_ledger where idempotency_key = 'k1'")).rejects.toThrow(/append-only/);
    await expect(db.query("insert into wallet_ledger (user_id, type, signed_credits, idempotency_key) values ($1,'topup',1,'k1')", [userId])).rejects.toThrow();
  });

  it("balance can never go negative or under-reserve", async () => {
    await expect(db.query("update wallets set posted_balance_credits = -1 where user_id = $1", [userId])).rejects.toThrow();
    await expect(db.query("update wallets set reserved_credits = posted_balance_credits + 1 where user_id = $1", [userId])).rejects.toThrow();
  });

  it("reserve -> commit charges actual units once, releases remainder", async () => {
    await fund(db, userId, 20);
    const before = await wallet(db, userId);
    const job = await makeJob(6);
    const { rows: r1 } = await db.query<{ wallet_reserve_for_job: string }>("select wallet_reserve_for_job($1)", [job]);
    expect(r1[0].wallet_reserve_for_job).toBe("scheduled");
    expect((await wallet(db, userId)).reserved).toBe(before.reserved + 6);

    const { rows: c1 } = await db.query<{ wallet_commit_for_job: string }>("select wallet_commit_for_job($1, 3, 'debit:a')", [job]);
    expect(Number(c1[0].wallet_commit_for_job)).toBe(3);
    const after = await wallet(db, userId);
    expect(after.posted).toBe(before.posted - 3);
    expect(after.reserved).toBe(before.reserved);

    // replay with the same key is a no-op
    const { rows: c2 } = await db.query<{ wallet_commit_for_job: string }>("select wallet_commit_for_job($1, 3, 'debit:a')", [job]);
    expect(Number(c2[0].wallet_commit_for_job)).toBe(3);
    expect((await wallet(db, userId)).posted).toBe(before.posted - 3);
    // a second commit with a new key fails: reservation no longer active
    await expect(db.query("select wallet_commit_for_job($1, 3, 'debit:b')", [job])).rejects.toThrow(/not active/);
  });

  it("commit for more than held takes the extra from available but never overdraws", async () => {
    const u2 = await createUser(db, "+9779841000002");
    await fund(db, u2, 10);
    const saved = userId;
    userId = u2;
    const job = await makeJob(3);
    userId = saved;
    await db.query("select wallet_reserve_for_job($1)", [job]);
    const { rows } = await db.query<{ wallet_commit_for_job: string }>("select wallet_commit_for_job($1, 50, 'debit:big')", [job]);
    expect(Number(rows[0].wallet_commit_for_job)).toBe(10);
    expect(await wallet(db, u2)).toEqual({ posted: 0, reserved: 0, available: 0 });
  });

  it("insufficient funds marks job awaiting_credits without overdraft; later top-up schedules it", async () => {
    const u3 = await createUser(db, "+9779841000003");
    await fund(db, u3, 2);
    const saved = userId;
    userId = u3;
    const job = await makeJob(3);
    userId = saved;
    const { rows } = await db.query<{ wallet_reserve_for_job: string }>("select wallet_reserve_for_job($1)", [job]);
    expect(rows[0].wallet_reserve_for_job).toBe("awaiting_credits");
    expect(await wallet(db, u3)).toEqual({ posted: 2, reserved: 0, available: 2 });
    await fund(db, u3, 5);
    const { rows: again } = await db.query<{ wallet_reserve_for_job: string }>("select wallet_reserve_for_job($1)", [job]);
    expect(again[0].wallet_reserve_for_job).toBe("scheduled");
    expect(await wallet(db, u3)).toEqual({ posted: 7, reserved: 3, available: 4 });
  });

  it("release returns hold; re-release is a no-op", async () => {
    const job = await makeJob(4);
    await db.query("select wallet_reserve_for_job($1)", [job]);
    const b = await wallet(db, userId);
    const { rows } = await db.query<{ wallet_release_for_job: string }>("select wallet_release_for_job($1)", [job]);
    expect(Number(rows[0].wallet_release_for_job)).toBe(4);
    expect((await wallet(db, userId)).reserved).toBe(b.reserved - 4);
    const { rows: r2 } = await db.query<{ wallet_release_for_job: string }>("select wallet_release_for_job($1)", [job]);
    expect(Number(r2[0].wallet_release_for_job)).toBe(0);
  });

  it("debit reversal is idempotent", async () => {
    const job = await makeJob(2);
    await db.query("select wallet_reserve_for_job($1)", [job]);
    const b = await wallet(db, userId);
    await db.query("select wallet_commit_for_job($1, 2, 'debit:rev')", [job]);
    await db.query("select wallet_reverse_debit_for_job($1, 'debit:rev')", [job]);
    await db.query("select wallet_reverse_debit_for_job($1, 'debit:rev')", [job]);
    expect((await wallet(db, userId)).posted).toBe(b.posted);
  });

  it("top-up is credited exactly once per order even under concurrent replay", async () => {
    const { rows } = await db.query<{ id: string }>(
      "insert into payment_orders (user_id, gateway, order_reference, amount_paisa, credits, status) values ($1,'mock','ORD-1',2000,20,'pending') returning id",
      [userId],
    );
    const b = await wallet(db, userId);
    const results = await Promise.all([1, 2, 3].map(() => db.query<{ wallet_apply_topup: boolean }>("select wallet_apply_topup($1, 'txn-1')", [rows[0].id])));
    expect(results.filter((r) => r.rows[0].wallet_apply_topup).length).toBe(1);
    expect((await wallet(db, userId)).posted).toBe(b.posted + 20);
    const { rows: o } = await db.query<{ status: string; verified_transaction_id: string }>("select status, verified_transaction_id from payment_orders where id = $1", [rows[0].id]);
    expect(o[0]).toEqual({ status: "paid", verified_transaction_id: "txn-1" });
  });

  it("refund reversal never drives balance negative; reports shortfall", async () => {
    const u4 = await createUser(db, "+9779841000004");
    const { rows } = await db.query<{ id: string }>(
      "insert into payment_orders (user_id, gateway, order_reference, amount_paisa, credits, status) values ($1,'mock','ORD-2',5000,50,'pending') returning id",
      [u4],
    );
    await db.query("select wallet_apply_topup($1, 'txn-2')", [rows[0].id]);
    // user spends 30
    await db.query("update wallets set posted_balance_credits = 20 where user_id = $1", [u4]);
    const { rows: s } = await db.query<{ wallet_reverse_topup: string }>("select wallet_reverse_topup($1, 'chargeback')", [rows[0].id]);
    expect(Number(s[0].wallet_reverse_topup)).toBe(30);
    expect((await wallet(db, u4)).posted).toBe(0);
  });

  it("admin adjustment requires a second approver", async () => {
    const a1 = await createUser(db, "+9779841000011", "admin");
    const { rows } = await db.query<{ id: string }>(
      "insert into wallet_adjustment_requests (user_id, signed_credits, reason, requested_by) values ($1, 5, 'goodwill', $2) returning id",
      [userId, a1],
    );
    await expect(db.query("update wallet_adjustment_requests set approved_by = $2, status='approved' where id = $1", [rows[0].id, a1])).rejects.toThrow();
    await expect(db.query("select wallet_apply_adjustment($1)", [rows[0].id])).rejects.toThrow(/second admin/);
  });
});

describe("dispatcher claim", () => {
  it("claims due scheduled jobs once; concurrent claimers do not overlap", async () => {
    const past = new Date(Date.now() - 60_000);
    const ids = [await makeJob(1, past), await makeJob(1, past), await makeJob(1, past)];
    for (const id of ids) await db.query("select wallet_reserve_for_job($1)", [id]);
    const [a, b] = await Promise.all([
      db.query<{ id: string }>("select id from jobs_claim_due(2, 60, 'w1')"),
      db.query<{ id: string }>("select id from jobs_claim_due(2, 60, 'w2')"),
    ]);
    const all = [...a.rows, ...b.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(3);
    const { rows: again } = await db.query("select id from jobs_claim_due(10, 60, 'w3')");
    expect(again.length).toBe(0);
  });

  it("stale lease with a pending attempt becomes unknown, without one goes back to scheduled", async () => {
    const past = new Date(Date.now() - 60_000);
    const j1 = await makeJob(1, past);
    const j2 = await makeJob(1, past);
    await db.query("update reminder_jobs set status='sending', lock_at = now() - interval '1 minute' where id in ($1,$2)", [j1, j2]);
    await db.query("insert into sms_attempts (job_id, attempt_no, provider, idempotency_key) values ($1, 1, 'mock', 'pend-1')", [j1]);
    const { rows } = await db.query<{ jobs_recover_stale_leases: number }>("select jobs_recover_stale_leases()");
    expect(Number(rows[0].jobs_recover_stale_leases)).toBe(2);
    const { rows: st } = await db.query<{ id: string; status: string }>("select id, status from reminder_jobs where id in ($1,$2)", [j1, j2]);
    expect(st.find((r) => r.id === j1)?.status).toBe("unknown");
    expect(st.find((r) => r.id === j2)?.status).toBe("scheduled");
  });
});
