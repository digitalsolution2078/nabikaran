import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser } from "./helpers/db";
import type { Db } from "@/lib/db";
import { base32Decode, base32Encode, currentStep, totpAt, verifyTotp } from "@/lib/auth/totp";
import { adminResetTwoFactor, beginSetup, confirmSetup, disableTwoFactor, regenerateRecoveryCodes, twoFactorRequired, twoFactorStatus, verifySecondFactor } from "@/lib/services/two-factor";
import { decryptSecret } from "@/lib/services/secrets";

let db: Db;
let close: () => Promise<void> = async () => undefined;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

const secretOf = async (uid: string) => decryptSecret((await db.query<{ totp_secret: string }>("select totp_secret from users where id = $1", [uid])).rows[0].totp_secret)!;

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vector and base32 round-trips", () => {
    // RFC 6238 SHA-1 secret "12345678901234567890"; T = 59 s → step 1 → 94287082 (8 digits) → 287082 (6 digits)
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(totpAt(secret, 1)).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
  });
  it("accepts ±1 step and refuses reuse", () => {
    const s = base32Encode(Buffer.from("abcdefghijabcdefghij"));
    const now = new Date();
    const step = currentStep(now);
    expect(verifyTotp(s, totpAt(s, step), null, now)).toBe(step);
    expect(verifyTotp(s, totpAt(s, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(s, totpAt(s, step - 3), null, now)).toBeNull();
    expect(verifyTotp(s, totpAt(s, step), step, now)).toBeNull(); // replay
    expect(verifyTotp(s, "12345", null, now)).toBeNull();
  });
});

describe("two-step sign-in service", () => {
  it("setup → confirm → sign-in code once → recovery once → regenerate → disable", async () => {
    const u = await createUser(db, "+9779841000500");
    expect(await twoFactorRequired(u, db)).toBe(false);
    const setup = await beginSetup(u, db);
    expect(setup.qrSvg).toContain("<svg");
    expect(await twoFactorRequired(u, db)).toBe(false); // not until confirmed
    const secret = await secretOf(u);
    await expect(confirmSetup(u, "000000", db)).rejects.toMatchObject({ code: "invalid_code" });
    const now = currentStep();
    const { recoveryCodes } = await confirmSetup(u, totpAt(secret, now), db);
    expect(recoveryCodes).toHaveLength(10);
    expect(await twoFactorRequired(u, db)).toBe(true);
    await expect(beginSetup(u, db)).rejects.toMatchObject({ code: "already_enabled" });

    // The code used to confirm cannot be used again; the next step's can.
    await expect(verifySecondFactor(u, totpAt(secret, now), db)).rejects.toMatchObject({ code: "invalid_code" });
    expect(await verifySecondFactor(u, totpAt(secret, now + 1), db)).toBe("app");
    expect(await verifySecondFactor(u, recoveryCodes[0].toLowerCase(), db)).toBe("recovery");
    await expect(verifySecondFactor(u, recoveryCodes[0], db)).rejects.toMatchObject({ code: "invalid_code" });
    expect((await twoFactorStatus(u, db)).recoveryLeft).toBe(9);

    // Codes for the secret of another account never work.
    const other = await createUser(db, "+9779841000501");
    await beginSetup(other, db);
    await expect(verifySecondFactor(other, totpAt(secret, now + 1), db)).rejects.toMatchObject({ code: "not_enabled" });

    await expect(regenerateRecoveryCodes(u, recoveryCodes[1], db)).rejects.toMatchObject({ code: "invalid_code" }); // needs an app code
    await expect(disableTwoFactor(u, "999999", db)).rejects.toMatchObject({ code: "invalid_code" });
    await disableTwoFactor(u, recoveryCodes[2], db);
    expect(await twoFactorStatus(u, db)).toMatchObject({ enabled: false, recoveryLeft: 0 });
  });

  it("super admin reset needs a reason and not oneself", async () => {
    const admin = await createUser(db, "+9779841000502", "admin");
    const u = await createUser(db, "+9779841000503");
    await beginSetup(u, db);
    await confirmSetup(u, totpAt(await secretOf(u), currentStep()), db);
    await expect(adminResetTwoFactor({ id: admin }, u, "x", db)).rejects.toMatchObject({ code: "reason_required" });
    await expect(adminResetTwoFactor({ id: u }, u, "lost my phone", db)).rejects.toMatchObject({ code: "self_reset" });
    await adminResetTwoFactor({ id: admin }, u, "Lost phone, verified by call", db);
    expect(await twoFactorRequired(u, db)).toBe(false);
  });
});
