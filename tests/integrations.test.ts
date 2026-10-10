import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser } from "./helpers/db";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { setIntegrationOverrides, integrationsVersion } from "@/lib/integrations";
import { getSmsProvider } from "@/lib/providers/sms";
import { decryptSecret, encryptSecret, setSecret, allSecretStatus } from "@/lib/services/secrets";
import { integrationStatus, refreshIntegrations, saveIntegrationSettings } from "@/lib/services/integrations";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let admin: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createUser(db, "+9779841000990", "admin");
});
afterAll(async () => {
  setIntegrationOverrides({});
  delete process.env.KHALTI_SECRET_KEY;
  await close();
});

describe("Admin → Integrations", () => {
  it("encrypts keys at rest and never stores the plain value", async () => {
    const enc = encryptSecret("aakash-token-123456");
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain("aakash-token");
    expect(decryptSecret(enc)).toBe("aakash-token-123456");
    expect(decryptSecret("enc:v1:broken")).toBeNull();
    expect(decryptSecret("legacy-plain")).toBe("legacy-plain"); // older rows
    await setSecret({ id: admin }, "aakash_auth_token", "aakash-token-123456", db);
    const { rows } = await db.query<{ v: string }>("select value::text as v from app_secrets where key = 'aakash_auth_token'");
    expect(rows[0].v).not.toContain("aakash-token-123456");
    const { rows: audit } = await db.query<{ d: string }>("select json_detail_redacted::text as d from audit_events where action = 'secret.updated' order by id desc limit 1");
    expect(audit[0].d).toContain("3456");
    expect(audit[0].d).not.toContain("aakash-token");
  });

  it("a key or mode saved in the panel is used instead of the server value, and switching applies without restart", async () => {
    const before = integrationsVersion();
    await saveIntegrationSettings({ id: admin }, { sms_provider: "aakash", payment_gateway: "env", khalti_env: "live", fonepay_mode: "env", fonepay_merchant_code: "NBK01", whatsapp_provider: "env" }, db);
    expect(integrationsVersion()).toBeGreaterThan(before);
    expect(env.smsProvider).toBe("aakash");
    expect(env.aakash.authToken).toBe("aakash-token-123456");
    expect(env.khalti.baseUrl).toBe("https://a.khalti.com");
    expect(env.fonepay.merchantCode).toBe("NBK01");
    expect(getSmsProvider().name).toBe("aakash"); // provider rebuilt with the new settings
    // Back to the server value.
    await setSecret({ id: admin }, "aakash_auth_token", null, db);
    await saveIntegrationSettings({ id: admin }, { sms_provider: "env", payment_gateway: "env", khalti_env: "env", fonepay_mode: "env", fonepay_merchant_code: "", whatsapp_provider: "env" }, db);
    expect(env.aakash.authToken).toBe(process.env.AAKASH_AUTH_TOKEN ?? "");
    expect(getSmsProvider().name).toBe("mock");
  });

  it("reports where each key comes from and what is missing", async () => {
    process.env.KHALTI_SECRET_KEY = "live_secret_key_env_9999";
    const st = await allSecretStatus(db);
    expect(st.khalti_secret_key).toMatchObject({ source: "env", last4: "9999", set: false });
    expect(st.whatsapp_access_token.source).toBe("none");
    await saveIntegrationSettings({ id: admin }, { sms_provider: "env", payment_gateway: "env", khalti_env: "env", fonepay_mode: "live", fonepay_merchant_code: "", whatsapp_provider: "meta" }, db);
    const s = await integrationStatus(db);
    const fp = s.providers.find((p) => p.key === "fonepay")!;
    expect(fp.ready).toBe(false);
    expect(fp.missing).toEqual(expect.arrayContaining(["merchant code", "username", "password", "secret key"]));
    expect(s.providers.find((p) => p.key === "whatsapp")!.missing).toContain("access token");
    await setSecret({ id: admin }, "whatsapp_access_token", "EAAG-token-abcd", db);
    await refreshIntegrations(db);
    expect(env.whatsapp.accessToken).toBe("EAAG-token-abcd");
    expect(env.whatsapp.provider).toBe("meta");
  });

  it("rejects unknown modes", async () => {
    await expect(saveIntegrationSettings({ id: admin }, { sms_provider: "twilio" }, db)).rejects.toBeTruthy();
  });
});
