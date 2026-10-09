/**
 * Nepal mobile number normalization.
 *
 * Accepts user input such as "9841234567", "09841234567", "+977 984-1234567",
 * "977-9841234567" and returns E.164 (+977XXXXXXXXXX) or null.
 *
 * Nepal mobile numbers are 10 digits starting with 97/98 (NTC, Ncell) or
 * 96 (Smart/UTL). We deliberately accept 96/97/98 and reject landlines.
 */
const MOBILE_PREFIX = /^9[678]\d{8}$/;

export function normalizeNepalPhone(input: string): string | null {
  if (typeof input !== "string") return null;
  let digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00977")) digits = digits.slice(5);
  else if (digits.startsWith("977")) digits = digits.slice(3);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!MOBILE_PREFIX.test(digits)) return null;
  return `+977${digits}`;
}

/** Mask for logs: +9779841****67 */
export function redactPhone(e164: string): string {
  if (!e164 || e164.length < 8) return "***";
  return `${e164.slice(0, 8)}****${e164.slice(-2)}`;
}

/** Local display form: 98-4123-4567 */
export function formatPhoneLocal(e164: string): string {
  const d = e164.replace(/^\+977/, "");
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}
