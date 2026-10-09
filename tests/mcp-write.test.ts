import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestDb, createUser, fund, inDays, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { registerClient } from "@/lib/oauth/clients";
import { validateAuthorizeRequest, issueAuthorizationCode } from "@/lib/oauth/codes";
import { exchangeToken } from "@/lib/oauth/tokens";
import { makePkcePair } from "@/lib/oauth/pkce";
import { retryAwaitingCredits } from "@/lib/core/wallet";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let clientId: string;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const localFetch: typeof fetch = async (input, init) => handleMcpRequest(new Request(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init));

async function tokenFor(userId: string, scope?: string) {
  const pkce = makePkcePair();
  const v = await validateAuthorizeRequest({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: scope ?? null, code_challenge: pkce.challenge, code_challenge_method: "S256", resource: env.mcpResource }, db);
  const code = await issueAuthorizationCode(v, userId, db);
  return (await exchangeToken({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pkce.verifier }, db)).access_token;
}
async function connect(userId: string, scope?: string) {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(env.mcpResource), { fetch: localFetch, requestInit: { headers: { authorization: `Bearer ${await tokenFor(userId, scope)}` } } }));
  return client;
}
type R = { isError?: boolean; structuredContent?: Record<string, unknown> & { error?: string }; content: Array<{ type: string; text?: string }> };
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }) as Promise<R>;
let seq = 0;
const key = () => `k-${Date.now()}-${++seq}`;
const prep = (over: Record<string, unknown> = {}) => ({ category: "bluebook", label: "Ba 2 Pa 1234", expiry: { calendar: "AD", date: inDays(40), source: "user_typed" }, offsets_minutes: [7 * 1440, 1440], ...over });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const { client } = await registerClient({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }, {}, db);
  clientId = client.id;
});
afterAll(() => close());

describe("prepare_reminder", () => {
  it("AD user-typed date: no confirmation needed; returns exact SMS text, cost and expected_expiry_ad; reserves nothing", async () => {
    const u = await createUser(db, "+9779841000801");
    await fund(db, u, 100);
    const c = await connect(u);
    const r = await call(c, "prepare_reminder", prep());
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent!;
    expect(s.requires_user_confirmation).toBe(false);
    expect(s.kind).toBe("create_reminder");
    expect((s.schedule as unknown[]).length).toBe(2);
    expect(String((s.schedule as Array<{ sms_text: string }>)[0].sms_text)).toContain("Ba 2 Pa 1234");
    expect(s.expected_expiry_ad).toBe(inDays(40));
    expect(s.reserved_on_confirm).toBeGreaterThan(0);
    expect((await wallet(db, u)).reserved).toBe(0);
    await c.close();
  });

  it("BS or image-extracted dates require explicit confirmation and show the AD/BS pair", async () => {
    const u = await createUser(db, "+9779841000802");
    const c = await connect(u);
    const bs = await call(c, "prepare_reminder", prep({ expiry: { calendar: "BS", date: "2084-02-10" } }));
    expect(bs.structuredContent).toMatchObject({ requires_user_confirmation: true, warnings: expect.arrayContaining(["bs_date_needs_confirmation"]) });
    expect(String(bs.structuredContent!.confirmation_prompt)).toMatch(/BS.*वि\.सं\./s);
    expect((bs.structuredContent!.resolved_expiry as { bs: string }).bs).toBe("2084-02-10");
    const img = await call(c, "prepare_reminder", prep({ expiry: { calendar: "AD", date: inDays(40), source: "extracted_from_image" } }));
    expect(img.structuredContent!.requires_user_confirmation).toBe(true);
    expect(String(img.structuredContent!.confirmation_prompt)).toMatch(/document image/);
    await c.close();
  });

  it("rejects invalid dates, all-past offsets and unknown reminder ids", async () => {
    const u = await createUser(db, "+9779841000803");
    const c = await connect(u);
    expect((await call(c, "prepare_reminder", prep({ expiry: { calendar: "BS", date: "2081-01-33" } }))).structuredContent?.error).toBe("invalid_bs_date");
    expect((await call(c, "prepare_reminder", prep({ expiry: { calendar: "AD", date: "2027-02-30" } }))).structuredContent?.error).toBe("invalid_date");
    expect((await call(c, "prepare_reminder", prep({ expiry: { calendar: "AD", date: inDays(2) }, offsets_minutes: [7 * 1440] }))).structuredContent?.error).toBe("nothing_to_schedule");
    expect((await call(c, "prepare_reminder", prep({ reminder_id: "11111111-1111-4111-8111-111111111111" }))).structuredContent?.error).toBe("not_found");
    await c.close();
  });
});

describe("confirm_reminder", () => {
  it("creates once and reserves; same idempotency_key replays; a second key on the same prepared_id does not create again", async () => {
    const u = await createUser(db, "+9779841000804");
    await fund(db, u, 100);
    const c = await connect(u);
    const p = (await call(c, "prepare_reminder", prep())).structuredContent!;
    const k = key();
    const a = await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: k });
    expect(a.isError).toBeFalsy();
    expect(a.structuredContent).toMatchObject({ replayed: false, funding: { status: "reserved", shortfall_credits: 0 } });
    expect(a.structuredContent!.reserved_credits).toBe(p.reserved_on_confirm);
    expect((await wallet(db, u)).reserved).toBe(p.reserved_on_confirm);
    const b = await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: k });
    expect(b.structuredContent!.replayed).toBe(true);
    const c2 = await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: key() });
    expect(c2.structuredContent!.replayed).toBe(true);
    expect((c2.structuredContent!.reminder as { id: string }).id).toBe((a.structuredContent!.reminder as { id: string }).id);
    const { rows } = await db.query<{ n: string }>("select count(*)::text as n from renewal_items where owner_user_id = $1", [u]);
    expect(Number(rows[0].n)).toBe(1);
    expect((await wallet(db, u)).reserved).toBe(p.reserved_on_confirm);
    await c.close();
  });

  it("concurrent confirms (retry storm) create exactly one reminder and one set of holds", async () => {
    const u = await createUser(db, "+9779841000805");
    await fund(db, u, 100);
    const c = await connect(u);
    const p = (await call(c, "prepare_reminder", prep())).structuredContent!;
    const k = key();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: k })));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.filter((r) => r.structuredContent!.replayed === false)).toHaveLength(1);
    expect((await wallet(db, u)).reserved).toBe(p.reserved_on_confirm);
    await c.close();
  });

  it("refuses wrong expected_expiry_ad, unconfirmed BS dates, foreign prepared_ids, expired snapshots and price changes", async () => {
    const u = await createUser(db, "+9779841000806");
    const other = await createUser(db, "+9779841000807");
    await fund(db, u, 100);
    const c = await connect(u);
    const p = (await call(c, "prepare_reminder", prep())).structuredContent!;
    expect((await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: "2000-01-01", idempotency_key: key() })).structuredContent?.error).toBe("expiry_mismatch");

    const bs = (await call(c, "prepare_reminder", prep({ expiry: { calendar: "BS", date: "2084-02-10" } }))).structuredContent!;
    expect((await call(c, "confirm_reminder", { prepared_id: bs.prepared_id, expected_expiry_ad: bs.expected_expiry_ad, idempotency_key: key() })).structuredContent?.error).toBe("confirmation_required");
    const bsOk = (await call(c, "prepare_reminder", prep({ expiry: { calendar: "BS", date: "2084-02-10", user_confirmed: true } }))).structuredContent!;
    const done = await call(c, "confirm_reminder", { prepared_id: bsOk.prepared_id, expected_expiry_ad: bsOk.expected_expiry_ad, idempotency_key: key() });
    expect(done.isError).toBeFalsy();
    expect((done.structuredContent!.reminder as { expiry_bs: string }).expiry_bs).toBe("2084-02-10");

    const oc = await connect(other);
    expect((await call(oc, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: key() })).structuredContent?.error).toBe("not_found");
    await oc.close();

    await db.query("update prepared_actions set expires_at = now() - interval '1 minute' where id = $1", [p.prepared_id]);
    expect((await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: key() })).structuredContent?.error).toBe("prepared_expired");

    const p2 = (await call(c, "prepare_reminder", prep({ label: "Priced" }))).structuredContent!;
    await db.query("insert into pricing_versions (credits_per_billable_unit) values (4)");
    expect((await call(c, "confirm_reminder", { prepared_id: p2.prepared_id, expected_expiry_ad: p2.expected_expiry_ad, idempotency_key: key() })).structuredContent?.error).toBe("price_changed");
    await db.query("delete from pricing_versions where credits_per_billable_unit = 4");
    expect((await wallet(db, u)).reserved).toBe(Number(bsOk.reserved_on_confirm));
    await c.close();
  });

  it("insufficient credits: confirm is refused with shortfall + top-up URL and saves nothing; after a top-up the same preparation confirms", async () => {
    const u = await createUser(db, "+9779841000808");
    await fund(db, u, 2);
    const c = await connect(u);
    const p = (await call(c, "prepare_reminder", prep())).structuredContent!;
    expect(p.warnings).toContain("insufficient_credits");
    const r = await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: key() });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: "insufficient_credits", neededCredits: Number(p.reserved_on_confirm), availableCredits: 2 });
    expect(String(r.structuredContent!.top_up_url)).toMatch(/\/wallet$/);
    expect(await wallet(db, u)).toEqual({ posted: 2, reserved: 0, available: 2 });
    const { rows } = await db.query("select 1 from renewal_items where owner_user_id = $1", [u]);
    expect(rows).toHaveLength(0);
    await fund(db, u, 100);
    const ok = await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: key() });
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent!.funding as { status: string }).status).toBe("reserved");
    expect((await wallet(db, u)).reserved).toBe(Number(p.reserved_on_confirm));
    await c.close();
  });

  it("scope: reminders:read token cannot prepare or confirm", async () => {
    const u = await createUser(db, "+9779841000809");
    const c = await connect(u, "reminders:read");
    expect((await call(c, "prepare_reminder", prep())).structuredContent).toMatchObject({ error: "insufficient_scope", required_scope: "reminders:write" });
    await c.close();
  });
});

describe("update_reminder / cancel_reminder", () => {
  it("edit via prepare(reminder_id) + confirm starts a new cycle; pause/resume and cancel move holds correctly", async () => {
    const u = await createUser(db, "+9779841000810");
    await fund(db, u, 200);
    const c = await connect(u);
    const p = (await call(c, "prepare_reminder", prep())).structuredContent!;
    const created = (await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: key() })).structuredContent!.reminder as { id: string; cycle_no: number };
    const hold1 = (await wallet(db, u)).reserved;

    const e = (await call(c, "prepare_reminder", prep({ reminder_id: created.id, label: "Renamed", offsets_minutes: [1440] }))).structuredContent!;
    expect(e.kind).toBe("update_reminder");
    const edited = (await call(c, "confirm_reminder", { prepared_id: e.prepared_id, expected_expiry_ad: e.expected_expiry_ad, idempotency_key: key() })).structuredContent!.reminder as { id: string; cycle_no: number; label: string; jobs: unknown[] };
    expect(edited.id).toBe(created.id);
    expect(edited.cycle_no).toBe(2);
    expect(edited.label).toBe("Renamed");
    expect(edited.jobs).toHaveLength(1);
    const hold2 = (await wallet(db, u)).reserved;
    expect(hold2).toBeLessThan(hold1);

    const paused = await call(c, "update_reminder", { reminder_id: created.id, action: "pause", idempotency_key: key() });
    expect((paused.structuredContent!.reminder as { status: string }).status).toBe("paused");
    expect((await wallet(db, u)).reserved).toBe(0);
    await call(c, "update_reminder", { reminder_id: created.id, action: "resume", idempotency_key: key() });
    expect((await wallet(db, u)).reserved).toBe(hold2);

    expect((await call(c, "cancel_reminder", { reminder_id: created.id, confirm: false, idempotency_key: key() })).structuredContent?.error).toBe("confirmation_required");
    const k = key();
    const cancelled = await call(c, "cancel_reminder", { reminder_id: created.id, confirm: true, idempotency_key: k });
    expect(cancelled.structuredContent).toMatchObject({ cancelled_jobs: 1, released_credits: hold2, replayed: false });
    expect((await wallet(db, u)).reserved).toBe(0);
    const again = await call(c, "cancel_reminder", { reminder_id: created.id, confirm: true, idempotency_key: k });
    expect(again.structuredContent).toMatchObject({ replayed: true, released_credits: 0 });
    await c.close();
  });

  it("another user's reminder cannot be edited, paused or cancelled (404)", async () => {
    const owner = await createUser(db, "+9779841000811");
    const intruder = await createUser(db, "+9779841000812");
    await fund(db, owner, 100);
    const oc = await connect(owner);
    const p = (await call(oc, "prepare_reminder", prep())).structuredContent!;
    const rid = ((await call(oc, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: key() })).structuredContent!.reminder as { id: string }).id;
    await oc.close();
    const ic = await connect(intruder);
    expect((await call(ic, "prepare_reminder", prep({ reminder_id: rid }))).structuredContent?.error).toBe("not_found");
    expect((await call(ic, "update_reminder", { reminder_id: rid, action: "pause", idempotency_key: key() })).structuredContent?.error).toBe("not_found");
    expect((await call(ic, "cancel_reminder", { reminder_id: rid, confirm: true, idempotency_key: key() })).structuredContent?.error).toBe("not_found");
    await ic.close();
    const { rows } = await db.query<{ status: string }>("select status from renewal_items where id = $1", [rid]);
    expect(rows[0].status).toBe("active");
  });
});

describe("MCP permission boundaries and confirmation content", () => {
  it("the confirmation prompt states message text, channel, AD/BS date, schedule and cost", async () => {
    const u = await createUser(db, "+9779841000851");
    await fund(db, u, 100);
    const c = await connect(u);
    const r = (await call(c, "prepare_reminder", prep({ expiry: { calendar: "BS", date: "2084-02-10" } }))).structuredContent!;
    const prompt = String(r.confirmation_prompt);
    expect(prompt).toContain("(AD)");
    expect(prompt).toContain("(BS)");
    expect(prompt).toContain("Channel: SMS");
    expect(prompt).toMatch(/SMS text: "Nabikaran: /);
    expect(prompt).toMatch(/Sends at \(Nepal time\): \d{4}-\d{2}-\d{2} \d{2}:\d{2}, \d{4}-/);
    expect(prompt).toMatch(/Cost: SMS 2 × 3 = 6; total 6 credits reserved now/);
    expect(r.channels).toEqual(["sms"]);
    expect((r.schedule as Array<{ channel: string; message_text: string }>)[0]).toMatchObject({ channel: "sms" });
    await c.close();
  });

  it("an assistant cannot give WhatsApp consent on the user's behalf", async () => {
    const { setWhatsAppAvailableForTests } = await import("@/lib/whatsapp/availability");
    setWhatsAppAvailableForTests(true);
    try {
      const u = await createUser(db, "+9779841000852");
      await fund(db, u, 100);
      const c = await connect(u);
      const p = (await call(c, "prepare_reminder", prep({ channels: ["sms", "whatsapp"] }))).structuredContent!;
      expect(p.warnings).toContain("whatsapp_consent_required");
      expect(String(p.confirmation_prompt)).toContain("Channel: SMS + WhatsApp");
      const r = await call(c, "confirm_reminder", { prepared_id: p.prepared_id, expected_expiry_ad: p.expected_expiry_ad, idempotency_key: key() });
      expect(r.structuredContent?.error).toBe("whatsapp_consent_required");
      expect(await wallet(db, u)).toEqual({ posted: 100, reserved: 0, available: 100 });
      await c.close();
    } finally {
      setWhatsAppAvailableForTests(undefined);
    }
  });

  it("no tool can top up the wallet or address another phone number", async () => {
    const u = await createUser(db, "+9779841000853");
    const c = await connect(u);
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names.some((n) => /top.?up|pay|credit_add|send_sms|send_message/i.test(n))).toBe(false);
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props.some((k) => /phone|recipient|to_number|destination|msisdn/i.test(k))).toBe(false);
    }
    // An unknown extra field cannot smuggle a destination either.
    const r = (await call(c, "prepare_reminder", prep({ phone: "+9779800000000" }))).structuredContent!;
    expect(JSON.stringify(r)).not.toContain("9800000000");
    await c.close();
  });
});
