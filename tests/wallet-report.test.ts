import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, principalFor, inDays } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { createReminder } from "@/lib/core/reminders";
import { runDispatcher, runReconciler } from "@/lib/services/dispatcher";
import { categorize, getReceipt, getStatement, listTopups } from "@/lib/services/wallet-report";
import { approveManualTopup, startManualTopup, submitManualTopup } from "@/lib/services/manual-topups";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
// Report everything as failed so the reconciler refund path runs.
sms.report = async (ids: string[]) => ids.map((id) => ({ providerMessageId: id, status: "failed" as const }));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  await close();
});

describe("wallet statement", () => {
  it("classifies every ledger movement", () => {
    expect(categorize("topup", "manual_topup", null)).toBe("purchased");
    expect(categorize("debit", "reminder_job", "sms")).toBe("spent_sms");
    expect(categorize("debit", "reminder_job", "whatsapp")).toBe("spent_whatsapp");
    expect(categorize("reversal", "reminder_job", "sms")).toBe("refunded");
    expect(categorize("reversal", "payment_order", null)).toBe("reversed");
    expect(categorize("fee", "phone_verification", null)).toBe("fee");
    expect(categorize("adjustment", "wallet_adjustment_request", null)).toBe("adjustment");
  });

  it("shows purchase, SMS spend and a refund for a failed SMS, and balances add up", async () => {
    const uid = await createUser(db, "+9779841000701");
    await fund(db, uid, 20);
    const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Doc", calendar: "AD", expiryDate: inDays(3), offsets: [0], notes: null, familyMemberLabel: null, localTime: "09:00" }, {}, db);
    await db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where id = $1", [reminder.jobs[0].id]);
    await runDispatcher(db, new Date());
    let st = await getStatement(uid, db);
    expect(st.totals).toMatchObject({ purchased: 20, spent_sms: -3, refunded: 0 });
    expect(st.rows.find((r) => r.category === "spent_sms")).toMatchObject({ channel: "sms", description: "Doc", credits: -3 });
    await runReconciler(db, new Date()); // provider reports failure → refund
    st = await getStatement(uid, db);
    expect(st.totals.refunded).toBe(3);
    expect(st.wallet.posted).toBe(20);
    const sum = Object.values(st.totals).reduce((a, b) => a + b, 0);
    expect(sum).toBe(st.wallet.posted);
  });

  it("lists QR and Khalti top-ups together, with receipts only for completed ones and only for the owner", async () => {
    const uid = await createUser(db, "+9779841000702");
    const other = await createUser(db, "+9779841000703");
    const admin = await createUser(db, "+9779841000704", "admin");
    const { request } = await startManualTopup(uid, 75, db);
    let rows = await listTopups(uid, db);
    expect(rows[0]).toMatchObject({ kind: "qr", reference: request.reference, receipt: false, method: "QR transfer (verified by staff)" });
    await submitManualTopup(uid, request.id, { payerTxnRef: "TXN12345" }, db);
    await approveManualTopup(admin, request.id, "EBL-REF-0001", null, db);
    rows = await listTopups(uid, db);
    expect(rows[0]).toMatchObject({ status: "approved", receipt: true });
    const r = await getReceipt("qr", request.id, uid, db);
    expect(r).toMatchObject({ amountNpr: 75, credits: 75, bankReference: "EBL-REF-0001", reference: request.reference });
    expect(await getReceipt("qr", request.id, other, db)).toBeNull();
  });
});
