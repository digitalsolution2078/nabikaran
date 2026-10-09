import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet, principalFor, inDays } from "./helpers/db";
import type { Db } from "@/lib/db";
import { mcpPrincipal, webPrincipal, requireScope, ALL_SCOPES, type Principal } from "@/lib/core/principal";
import { ScopeError, RateLimitError } from "@/lib/core/errors";
import { createReminder, updateReminder, setReminderStatus, listReminders, getReminder, previewSchedule, listJobsForUser } from "@/lib/core/reminders";
import { getAccount } from "@/lib/core/account";
import { getWalletSummary, getLedger } from "@/lib/core/wallet";
import { checkRateLimit } from "@/lib/core/rate-limit";
import { withIdempotency } from "@/lib/core/idempotency";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let alice: string;
let bob: string;
const base = { category: "bluebook" as const, calendar: "AD" as const, localTime: "09:00", notes: null, familyMemberLabel: null };
const mcp = (userId: string, scopes: Principal["scopes"] = ALL_SCOPES, tokenId = "11111111-1111-4111-8111-111111111111") =>
  mcpPrincipal({ userId, locale: "ne-NP", scopes: [...scopes], clientId: "chatgpt", tokenId });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  alice = await createUser(db, "+9779841000501");
  bob = await createUser(db, "+9779841000502");
  await fund(db, alice, 500);
  await fund(db, bob, 500);
});
afterAll(() => close());

describe("principal & scopes", () => {
  it("web principal carries every scope; mcp principal only what the token granted (unknown scopes dropped)", () => {
    expect(webPrincipal({ id: alice, locale: "ne-NP" }).scopes).toEqual(ALL_SCOPES);
    const p = mcpPrincipal({ userId: alice, locale: "ne-NP", scopes: ["reminders:read", "admin:*" as never], clientId: "c", tokenId: "t" });
    expect(p.scopes).toEqual(["reminders:read"]);
    expect(() => requireScope(p, "reminders:write")).toThrow(ScopeError);
  });

  it("scope checks are enforced inside core, not only at the transport", async () => {
    const readOnly = mcp(alice, ["reminders:read", "account:read"]);
    await expect(createReminder(readOnly, { ...base, label: "x", expiryDate: inDays(30), offsets: [0] }, {}, db)).rejects.toThrow(ScopeError);
    await expect(getWalletSummary(readOnly, db)).rejects.toThrow(ScopeError);
    await expect(getLedger(readOnly, 10, db)).rejects.toThrow(ScopeError);
    await expect(listReminders(mcp(alice, ["wallet:read"]), {}, db)).rejects.toThrow(ScopeError);
    await expect(getAccount(mcp(alice, ["wallet:read"]), db)).rejects.toThrow(ScopeError);
    // the same calls succeed with the right scopes
    expect((await getAccount(mcp(alice, ["account:read"]), db)).phoneMasked).toBe("+9779841****01");
    expect((await getWalletSummary(mcp(alice, ["wallet:read"]), db)).topUpUrl).toMatch(/\/wallet$/);
  });
});

describe("user isolation", () => {
  it("one user can never read, update or cancel another user's reminder", async () => {
    const { reminder } = await createReminder(principalFor(alice), { ...base, label: "Alice car", expiryDate: inDays(30), offsets: [1440] }, {}, db);
    const bobP = mcp(bob);
    expect(await getReminder(bobP, reminder.id, db)).toBeNull();
    expect((await listReminders(bobP, {}, db)).reminders.find((r) => r.id === reminder.id)).toBeUndefined();
    await expect(updateReminder(bobP, reminder.id, { ...base, label: "hijack", expiryDate: inDays(31), offsets: [0] }, {}, db)).rejects.toMatchObject({ status: 404 });
    await expect(setReminderStatus(bobP, reminder.id, "cancel", {}, db)).rejects.toMatchObject({ status: 404 });
    const still = await getReminder(principalFor(alice), reminder.id, db);
    expect(still?.label).toBe("Alice car");
    expect(still?.status).toBe("active");
  });
});

describe("idempotent mutations", () => {
  it("same key twice creates one reminder and replays the stored result", async () => {
    const p = mcp(alice);
    const input = { ...base, label: "Idem", expiryDate: inDays(30), offsets: [7 * 1440, 0] };
    const a = await createReminder(p, input, { idempotencyKey: "k-create-1" }, db);
    const b = await createReminder(p, input, { idempotencyKey: "k-create-1" }, db);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.reminder.id).toBe(a.reminder.id);
    const { rows } = await db.query<{ n: string }>("select count(*)::text as n from renewal_items where owner_user_id = $1 and label = 'Idem'", [alice]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("concurrent duplicate confirms yield exactly one reminder and one set of reservations", async () => {
    const p = mcp(alice);
    const before = await wallet(db, alice);
    const input = { ...base, label: "Race", expiryDate: inDays(45), offsets: [1440] };
    const results = await Promise.all([1, 2, 3, 4].map(() => createReminder(p, input, { idempotencyKey: "k-race" }, db)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.reminder.id)).size).toBe(1);
    const hold = results[0].reminder.jobs[0].estimatedCredits;
    expect((await wallet(db, alice)).reserved).toBe(before.reserved + hold);
  });

  it("a key is bound to its user and operation", async () => {
    const input = { ...base, label: "Keyed", expiryDate: inDays(30), offsets: [0] };
    const a = await createReminder(mcp(alice), input, { idempotencyKey: "shared-key" }, db);
    const b = await createReminder(mcp(bob), input, { idempotencyKey: "shared-key" }, db); // different user, different namespace
    expect(b.replayed).toBe(false);
    expect(b.reminder.id).not.toBe(a.reminder.id);
    await expect(setReminderStatus(mcp(alice), a.reminder.id, "cancel", { idempotencyKey: "shared-key" }, db)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("status changes replay without double-releasing", async () => {
    const p = mcp(alice);
    const { reminder } = await createReminder(p, { ...base, label: "Cancel twice", expiryDate: inDays(30), offsets: [1440] }, {}, db);
    const before = await wallet(db, alice);
    const hold = reminder.jobs[0].estimatedCredits;
    const first = await setReminderStatus(p, reminder.id, "cancel", { idempotencyKey: "k-cancel" }, db);
    const second = await setReminderStatus(p, reminder.id, "cancel", { idempotencyKey: "k-cancel" }, db);
    expect(first.cancelled).toBe(1);
    expect(second.replayed).toBe(true);
    expect(second.cancelled).toBe(1); // stored response, not a second release
    expect((await wallet(db, alice)).reserved).toBe(before.reserved - hold);
  });

  it("withIdempotency does not store a response when the operation throws, so a retry can succeed", async () => {
    let calls = 0;
    await expect(db.tx((tx) => withIdempotency(tx, alice, "k-fail", "op", async () => { calls++; throw new Error("boom"); }))).rejects.toThrow("boom");
    const r = await db.tx((tx) => withIdempotency(tx, alice, "k-fail", "op", async () => { calls++; return "ok"; }));
    expect(r).toEqual({ result: "ok", replayed: false });
    expect(calls).toBe(2);
  });
});

describe("insufficient credits and scheduling warnings", () => {
  it("preview flags BS dates, past offsets, over-cap and shortfall; an underfunded create is refused", async () => {
    const poor = await createUser(db, "+9779841000503");
    await fund(db, poor, 2);
    const p = mcp(poor);
    const pv = await previewSchedule(p, { label: "Passport", calendar: "BS", expiryDate: "2085-01-01", localTime: "09:00", offsets: [365 * 1440 * 3, ...Array.from({ length: 12 }, (_, i) => i * 1440)] }, db);
    expect(pv.warnings).toEqual(expect.arrayContaining(["bs_date_needs_confirmation", "insufficient_credits", "over_cap"]));
    expect(pv.expiry.bs?.date).toBe("2085-01-01");
    // Two SMS need 6 credits; the wallet holds 2 → refused, nothing saved, nothing reserved.
    await expect(createReminder(p, { ...base, category: "passport", label: "Passport", calendar: "BS", expiryDate: "2085-01-01", offsets: [1440, 0] }, {}, db))
      .rejects.toMatchObject({ status: 402, code: "insufficient_credits", detail: { neededCredits: 6, availableCredits: 2, shortfallCredits: 4 } });
    expect(await wallet(db, poor)).toEqual({ posted: 2, reserved: 0, available: 2 });
    const { rows } = await db.query("select 1 from renewal_items where owner_user_id = $1", [poor]);
    expect(rows).toHaveLength(0);
  });

  it("list pagination with cursor returns each reminder exactly once", async () => {
    const p = mcp(alice);
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof listReminders>> = await listReminders(p, { status: "all", limit: 2, cursor }, db);
      for (const r of page.reminders) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    const { rows } = await db.query<{ n: string }>("select count(*)::text as n from renewal_items where owner_user_id = $1 and status <> 'deleted'", [alice]);
    expect(seen.size).toBe(Number(rows[0].n));
  });
});

describe("audit and rate limiting", () => {
  it("audit rows record channel, client and token", async () => {
    const p = mcp(alice, ALL_SCOPES, "22222222-2222-4222-8222-222222222222");
    const { reminder } = await createReminder(p, { ...base, label: "Audited", expiryDate: inDays(30), offsets: [0] }, {}, db);
    const { rows } = await db.query<{ actor_via: string; actor_client_id: string; actor_token_id: string; actor_user_id: string }>(
      "select actor_via, actor_client_id, actor_token_id, actor_user_id from audit_events where action = 'reminder.create' and target_id = $1",
      [reminder.id],
    );
    expect(rows[0]).toEqual({ actor_via: "mcp", actor_client_id: "chatgpt", actor_token_id: "22222222-2222-4222-8222-222222222222", actor_user_id: alice });
  });

  it("fixed-window limiter blocks the (limit+1)th call and resets next window", async () => {
    const rule = { bucket: "tool:prepare", limit: 3, windowSeconds: 600 };
    const t0 = new Date("2026-10-09T10:00:00Z");
    for (let i = 0; i < 3; i++) await checkRateLimit(db, "token:abc", rule, t0);
    await expect(checkRateLimit(db, "token:abc", rule, t0)).rejects.toThrow(RateLimitError);
    await expect(checkRateLimit(db, "token:other", rule, t0)).resolves.toEqual({ remaining: 2 });
    await expect(checkRateLimit(db, "token:abc", rule, new Date("2026-10-09T10:10:00Z"))).resolves.toEqual({ remaining: 2 });
  });
});

describe("row normalisation", () => {
  it("listJobsForUser returns ISO strings (sortable) even though the driver returns Date", async () => {
    const jobs = await listJobsForUser(principalFor(alice), 50, db);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(j.due_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => [...jobs].sort((a, b) => a.due_at_utc.localeCompare(b.due_at_utc))).not.toThrow();
  });
});
