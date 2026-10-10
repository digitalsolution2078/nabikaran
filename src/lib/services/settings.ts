import { z } from "zod";
import { getDb, type Db } from "../db";
import { audit } from "../core/audit";
import { HttpError } from "../core/errors";

/**
 * Admin-managed, non-secret settings (app_settings). Provider credentials and
 * payment secrets never live here — they stay in the server environment.
 */
export const topupSettingsSchema = z
  .object({
    min_npr: z.number().int().min(1).max(100000),
    max_npr: z.number().int().min(1).max(1000000),
    quick_amounts: z.array(z.number().int().positive()).min(1).max(8),
  })
  .refine((v) => v.min_npr <= v.max_npr, "min_npr must be ≤ max_npr")
  .refine((v) => v.quick_amounts.every((a) => a >= v.min_npr && a <= v.max_npr), "quick amounts must lie within min and max");

export const manualQrSettingsSchema = z.object({
  enabled: z.boolean(),
  image_path: z.string().regex(/^\/[A-Za-z0-9/_.-]+\.(png|jpg|jpeg|webp|svg)$/, "must be a path under /public"),
  network: z.string().min(1).max(40),
  merchant_name: z.string().min(1).max(80),
  terminal_id: z.string().max(40).default(""),
  /** Set true only after the owner confirmed the merchant account belongs to the business. */
  verified: z.boolean(),
});

/** Sign-in SMS fee and the balance below which a customer must top up before using the service. */
export const signinSettingsSchema = z.object({
  fee_credits: z.number().int().min(0).max(10),
  min_balance: z.number().int().min(-1000).max(0),
  /** Staff (admin / super_admin) are exempt from the fee and the lock unless this is true. */
  charge_staff: z.boolean(),
});

/** Non-secret WhatsApp settings. Tokens and the app secret live only in the server environment. */
export const whatsappSettingsSchema = z.object({
  enabled: z.boolean(),
  phone_number_id: z.string().regex(/^\d{0,30}$/, "Phone number ID is digits only"),
  business_account_id: z.string().regex(/^\d{0,30}$/, "Business account ID is digits only"),
  template_namespace: z.string().max(80),
  default_language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Use a Meta language code such as en or ne"),
});

/** Referral programme. Rewards are paid after the invited customer's first qualifying paid top-up. */
export const referralSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Credits for the person who shared the link. */
  referrer_credits: z.number().int().min(0).max(1000),
  /** Credits for the new customer. */
  referee_credits: z.number().int().min(0).max(1000),
  /** The invited customer's paid top-ups must reach this many rupees before anyone is rewarded. */
  min_topup_npr: z.number().int().min(1).max(100000),
  /** Most rewards one customer can earn (stops farming). */
  max_rewards_per_referrer: z.number().int().min(0).max(10000),
  /** Optional line shown on the invite card and landing page. */
  message: z.string().max(200),
});

/** Optional PIN sign-in (skips the OTP SMS and the sign-in fee). */
export const pinSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Wrong attempts before the PIN locks (a normal OTP sign-in unlocks it). */
  max_attempts: z.number().int().min(3).max(10),
});

export type TopupSettings = z.infer<typeof topupSettingsSchema>;
export type ManualQrSettings = z.infer<typeof manualQrSettingsSchema>;
export type SigninSettings = z.infer<typeof signinSettingsSchema>;
export type WhatsappSettings = z.infer<typeof whatsappSettingsSchema>;
export type ReferralSettings = z.infer<typeof referralSettingsSchema>;
export type PinSettings = z.infer<typeof pinSettingsSchema>;

const SCHEMAS = { topup: topupSettingsSchema, manual_qr: manualQrSettingsSchema, signin: signinSettingsSchema, whatsapp: whatsappSettingsSchema, referral: referralSettingsSchema, pin: pinSettingsSchema } as const;
type Key = keyof typeof SCHEMAS;

const DEFAULTS: { topup: TopupSettings; manual_qr: ManualQrSettings; signin: SigninSettings; whatsapp: WhatsappSettings; referral: ReferralSettings; pin: PinSettings } = {
  topup: { min_npr: 20, max_npr: 10000, quick_amounts: [50, 100, 250, 500, 1000] },
  manual_qr: { enabled: true, image_path: "/payments/fonepay-qr.png", network: "Fonepay", merchant_name: "NARIKOT DIGITAL PRIVATE LIMITED", terminal_id: "2222010021806804", verified: false },
  signin: { fee_credits: 1, min_balance: -5, charge_staff: false },
  whatsapp: { enabled: false, phone_number_id: "", business_account_id: "", template_namespace: "", default_language: "en" },
  referral: { enabled: true, referrer_credits: 20, referee_credits: 10, min_topup_npr: 50, max_rewards_per_referrer: 25, message: "" },
  pin: { enabled: true, max_attempts: 5 },
};

export async function getSetting<K extends Key>(key: K, db: Db = getDb()): Promise<(typeof DEFAULTS)[K]> {
  const { rows } = await db.query<{ value: unknown }>("select value from app_settings where key = $1", [key]);
  const parsed = SCHEMAS[key].safeParse(rows[0]?.value);
  return (parsed.success ? parsed.data : DEFAULTS[key]) as (typeof DEFAULTS)[K];
}

export async function setSetting<K extends Key>(actor: { id: string }, key: K, value: unknown, db: Db = getDb()): Promise<(typeof DEFAULTS)[K]> {
  const parsed = SCHEMAS[key].safeParse(value);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_setting");
  const before = await getSetting(key, db);
  await db.query(
    "insert into app_settings (key, value, updated_by, updated_at) values ($1, $2, $3, now()) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()",
    [key, JSON.stringify(parsed.data), actor.id],
  );
  await audit(db, { userId: actor.id, via: "web", scopes: [], locale: "en" }, "settings.update", { type: "app_setting", id: key }, { before, after: parsed.data });
  return parsed.data as (typeof DEFAULTS)[K];
}

/** NPR → credits. Policy: 1 credit = NPR 1 of prepaid value (whole rupees only). */
export function creditsForNpr(npr: number): number {
  return Math.floor(npr);
}

export async function validateTopupAmount(npr: number, db: Db = getDb()): Promise<{ amountPaisa: number; credits: number }> {
  const s = await getSetting("topup", db);
  if (!Number.isInteger(npr)) throw new HttpError(400, "Enter a whole rupee amount", "invalid_amount");
  if (npr < s.min_npr) throw new HttpError(400, `Minimum top-up is NPR ${s.min_npr}`, "amount_too_small");
  if (npr > s.max_npr) throw new HttpError(400, `Maximum top-up is NPR ${s.max_npr}`, "amount_too_large");
  return { amountPaisa: npr * 100, credits: creditsForNpr(npr) };
}
