import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund } from "./helpers/db";
import type { Db } from "@/lib/db";
import { can, isAdminRole, STAFF_ROLES, type Permission, type Role } from "@/lib/auth/rbac";
import { approveManualTopup, rejectManualTopup, startManualTopup, submitManualTopup } from "@/lib/services/manual-topups";
import { setUserRole, addNote, directAdjustment } from "@/lib/services/admin-console";
import { saveWhatsappSettings, saveWaTemplate } from "@/lib/services/whatsapp-admin";
import { getSetting } from "@/lib/services/settings";

let db: Db;
let close: () => Promise<void> = async () => undefined;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

const ALL: Permission[] = ["admin.view", "topups.decide", "adjustments.request", "adjustments.approve", "adjustments.direct", "templates.manage", "sms.manage", "whatsapp.manage", "settings.manage", "roles.manage", "notes.write", "oauth.manage"];

describe("role permission matrix", () => {
  it("grants exactly the documented permissions", () => {
    const has = (r: Role) => ALL.filter((p) => can(r, p));
    expect(has("user")).toEqual([]);
    expect(has("auditor")).toEqual(["admin.view"]);
    expect(has("content")).toEqual(["admin.view", "templates.manage"]);
    expect(has("support")).toEqual(["admin.view", "adjustments.request", "notes.write"]);
    expect(has("finance")).toEqual(["admin.view", "topups.decide", "adjustments.request", "adjustments.approve"]);
    expect(has("super_admin")).toEqual(ALL);
    for (const r of STAFF_ROLES) expect(isAdminRole(r)).toBe(true);
    expect(isAdminRole("user")).toBe(false);
    expect(can("hacker" as Role, "admin.view")).toBe(false);
  });

  it("sensitive actions are refused for roles without the permission (never only hidden in the UI)", () => {
    for (const r of ["auditor", "content", "support"] as Role[]) {
      expect(can(r, "topups.decide")).toBe(false);
      expect(can(r, "sms.manage")).toBe(false);
      expect(can(r, "whatsapp.manage")).toBe(false);
      expect(can(r, "roles.manage")).toBe(false);
      expect(can(r, "adjustments.direct")).toBe(false);
    }
    expect(can("finance", "whatsapp.manage")).toBe(false);
    expect(can("admin", "whatsapp.manage")).toBe(false);
  });
});

describe("database-level enforcement", () => {
  async function pendingTopup(phone: string) {
    const uid = await createUser(db, phone);
    const { request } = await startManualTopup(uid, 100, db);
    await submitManualTopup(uid, request.id, { payerTxnRef: "TXN-9999" }, db);
    return { uid, id: request.id };
  }
  const staff = async (phone: string, role: string) => {
    const id = await createUser(db, phone);
    await db.query("update users set role = $2 where id = $1", [id, role]);
    return id;
  };

  it("only admin / super_admin / finance can approve or reject top-ups, even calling SQL directly", async () => {
    const support = await staff("+9779841000801", "support");
    const auditor = await staff("+9779841000802", "auditor");
    const finance = await staff("+9779841000803", "finance");
    const t1 = await pendingTopup("+9779841000804");
    await expect(approveManualTopup(support, t1.id, "BANKREF-1", null, db)).rejects.toMatchObject({ code: "approve_refused" });
    await expect(rejectManualTopup(auditor, t1.id, "nope", db)).rejects.toMatchObject({ code: "reject_refused" });
    expect(await approveManualTopup(finance, t1.id, "BANKREF-1", null, db)).toEqual({ credited: true });
  });

  it("nobody approves their own top-up, whatever their role", async () => {
    const finance = await staff("+9779841000805", "finance");
    const { request } = await startManualTopup(finance, 50, db);
    await submitManualTopup(finance, request.id, { payerTxnRef: "TXN-1234" }, db);
    await expect(approveManualTopup(finance, request.id, "BANKREF-2", null, db)).rejects.toThrow(/own top-up/);
  });

  it("direct adjustments and role changes are super-admin only", async () => {
    const admin = await staff("+9779841000806", "admin");
    const victim = await createUser(db, "+9779841000807");
    await fund(db, victim, 10);
    await expect(directAdjustment(admin, victim, 5, "goodwill credit", "k-1", db)).rejects.toBeTruthy();
    await expect(setUserRole({ id: admin, role: "admin" }, victim, "admin", db)).rejects.toMatchObject({ status: 403 });
    const su = await staff("+9779841000808", "super_admin");
    await setUserRole({ id: su, role: "super_admin" }, victim, "finance", db);
    const { rows } = await db.query<{ role: string }>("select role from users where id = $1", [victim]);
    expect(rows[0].role).toBe("finance");
    await expect(setUserRole({ id: su, role: "super_admin" }, su, "user", db)).rejects.toMatchObject({ code: "self_role_change" });
  });

  it("support notes are append-only", async () => {
    const support = await staff("+9779841000809", "support");
    const cust = await createUser(db, "+9779841000810");
    const id = await addNote(support, cust, "Called about a failed SMS", db);
    await expect(db.query("update admin_notes set body = 'x' where id = $1", [id])).rejects.toThrow();
    await expect(db.query("delete from admin_notes where id = $1", [id])).rejects.toThrow();
  });

  it("WhatsApp settings never store secrets and are audited", async () => {
    const su = await staff("+9779841000811", "super_admin");
    await saveWhatsappSettings(su, { enabled: true, phone_number_id: "1234567", business_account_id: "7654321", template_namespace: "", default_language: "en", access_token: "EAAG-SECRET", app_secret: "s3cret" }, db);
    const { rows } = await db.query<{ value: Record<string, unknown> }>("select value from app_settings where key = 'whatsapp'");
    expect(JSON.stringify(rows[0].value)).not.toMatch(/EAAG|s3cret|access_token|app_secret/);
    expect((await getSetting("whatsapp", db)).phone_number_id).toBe("1234567");
    const { rows: a } = await db.query("select 1 from audit_events where action = 'whatsapp.settings.update'");
    expect(a.length).toBe(1);
    await expect(saveWhatsappSettings(su, { enabled: true, phone_number_id: "abc", business_account_id: "", template_namespace: "", default_language: "en" }, db)).rejects.toMatchObject({ code: "invalid_setting" });
    const v = await saveWaTemplate(su, { locale: "en-NP", category: "default", meta_name: "nabikaran_reminder_v2", meta_language: "en", body_preview: "Hi, {{1}} expires in {{2}} days on {{3}}." }, db);
    expect(v).toBe(2);
    const { rows: act } = await db.query<{ meta_name: string }>("select meta_name from whatsapp_templates where locale = 'en-NP' and category = 'default' and active");
    expect(act.map((r) => r.meta_name)).toEqual(["nabikaran_reminder_v2"]);
    await expect(saveWaTemplate(su, { locale: "en-NP", category: "default", meta_name: "Bad Name", meta_language: "en", body_preview: "{{1}} {{2}} {{3}}" }, db)).rejects.toMatchObject({ code: "invalid_template" });
  });
});
