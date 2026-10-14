import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser } from "./helpers/db";
import type { Db } from "@/lib/db";
import { overridesFrom } from "@/lib/services/integrations";
import { setPaymentGatewayForTests } from "@/lib/payments";
import type { PaymentGateway } from "@/lib/payments/types";
import { createCustomTopupOrder } from "@/lib/services/payments";

let db: Db;
let close: () => Promise<void> = async () => undefined;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => {
  setPaymentGatewayForTests(undefined);
  await close();
});

const base = { sms_provider: "env", payment_gateway: "khalti", fonepay_mode: "env", fonepay_merchant_code: "", whatsapp_provider: "env" } as const;

describe("Khalti environment", () => {
  it("live uses khalti.com (production API), test uses the dev.khalti.com sandbox", () => {
    expect(overridesFrom({ ...base, khalti_env: "live" }, {}).khaltiBaseUrl).toBe("https://khalti.com");
    expect(overridesFrom({ ...base, khalti_env: "test" }, {}).khaltiBaseUrl).toBe("https://dev.khalti.com");
    expect(overridesFrom({ ...base, khalti_env: "env" }, {}).khaltiBaseUrl).toBeUndefined();
  });

  it("a gateway that refuses to start a payment gives a clear error and leaves no pending order", async () => {
    const broken: PaymentGateway = {
      name: "khalti",
      initiate: async () => { throw new Error("Khalti initiate failed (401): Invalid token"); },
      lookup: async (ref) => ({ gatewayRef: ref, status: "unknown", amountPaisa: null, transactionId: null }),
    };
    setPaymentGatewayForTests(broken);
    const uid = await createUser(db, "+9779841005001");
    await expect(createCustomTopupOrder({ id: uid, phoneE164: "+9779841005001" }, 500, db, "khalti")).rejects.toMatchObject({ status: 502, code: "payment_start_failed" });
    const { rows } = await db.query<{ status: string }>("select status from payment_orders where user_id = $1", [uid]);
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
  });
});
