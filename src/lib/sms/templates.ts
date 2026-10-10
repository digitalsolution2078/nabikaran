import { estimateSegments, isGsm7, type SegmentEstimate } from "./segments";
import { formatKathmandu, daysBetween } from "../time";
import { hasOwnWording } from "../categories";

/**
 * Outgoing reminder SMS are English or Romanized Nepali only, encoded as
 * GSM-7 and kept within ONE segment (160 septets). Devanagari is never sent:
 * it forces UCS-2 (70 chars/segment) and multiplies provider units.
 *
 * Template locale: 'en-NP' = English SMS, 'ne-NP' = Romanized Nepali SMS.
 */
export const SMS_MAX_SEGMENTS = 1;
export const SMS_SINGLE_SEGMENT_SEPTETS = 160;
export const SMS_LABEL_MAX = 30;

export interface TemplateRow {
  locale: string;
  category: string;
  body: string;
}

export interface RenderInput {
  label: string;
  /** Fallback English/Roman name used when the label cannot be sent as GSM-7 (e.g. Devanagari). */
  fallbackLabel?: string;
  expiryAtUtc: Date;
  dueAtUtc: Date;
  locale?: string;
  /** Reminder category; occasions (birthday, anniversary, event) use their own wording. */
  category?: string;
}

export interface RenderedMessage {
  body: string;
  estimate: SegmentEstimate;
  templateCategory: string;
  /** The label actually used in the SMS. */
  smsLabel: string;
  /** True when the user's label was replaced or shortened for SMS. */
  labelAdjusted: boolean;
}

export const FALLBACK_TEMPLATES: TemplateRow[] = [
  { locale: "en-NP", category: "default", body: "Nabikaran: Your {label} expires in {days} day(s) on {date}. Please renew on time." },
  { locale: "en-NP", category: "today", body: "Nabikaran: Your {label} expires today ({date}). Please renew on time." },
  { locale: "ne-NP", category: "default", body: "Nabikaran: Tapaiko {label} ko myad {days} din pachhi ({date}) sakinchha. Samayamai nabikaran garnuhos." },
  { locale: "ne-NP", category: "today", body: "Nabikaran: Tapaiko {label} ko myad aaja ({date}) sakinchha. Samayamai nabikaran garnuhos." },
  // Occasions: {label} is the person or event name typed by the customer. Sent to the customer only.
  { locale: "en-NP", category: "birthday", body: "Nabikaran: {label}'s birthday is in {days} day(s), on {date}. Don't forget to wish!" },
  { locale: "en-NP", category: "birthday_today", body: "Nabikaran: Today ({date}) is {label}'s birthday. Don't forget to wish!" },
  { locale: "ne-NP", category: "birthday", body: "Nabikaran: {label} ko janmadin {days} din pachhi ({date}) chha. Shubhakamana dina nabirsinuhos!" },
  { locale: "ne-NP", category: "birthday_today", body: "Nabikaran: Aaja ({date}) {label} ko janmadin ho. Shubhakamana dina nabirsinuhos!" },
  { locale: "en-NP", category: "anniversary", body: "Nabikaran: {label} anniversary is in {days} day(s), on {date}." },
  { locale: "en-NP", category: "anniversary_today", body: "Nabikaran: Today ({date}) is {label} anniversary." },
  { locale: "ne-NP", category: "anniversary", body: "Nabikaran: {label} ko barshik utsav {days} din pachhi ({date}) chha." },
  { locale: "ne-NP", category: "anniversary_today", body: "Nabikaran: Aaja ({date}) {label} ko barshik utsav ho." },
  { locale: "en-NP", category: "event", body: "Nabikaran: {label} is in {days} day(s), on {date}." },
  { locale: "en-NP", category: "event_today", body: "Nabikaran: {label} is today ({date})." },
  { locale: "ne-NP", category: "event", body: "Nabikaran: {label} {days} din pachhi ({date}) chha." },
  { locale: "ne-NP", category: "event_today", body: "Nabikaran: {label} aaja ({date}) chha." },
  // Pro: free trials and cancellation deadlines. Never claim the service cancels anything itself.
  { locale: "en-NP", category: "free_trial", body: "Nabikaran: Your {label} free trial ends in {days} day(s), on {date}. Cancel before then if you do not want to be charged." },
  { locale: "en-NP", category: "free_trial_today", body: "Nabikaran: Your {label} free trial ends today ({date}). Cancel today if you do not want to be charged." },
  { locale: "ne-NP", category: "free_trial", body: "Nabikaran: Tapaiko {label} free trial {days} din pachhi ({date}) sakinchha. Paisa katna nadina tyo bhanda agadi cancel garnuhos." },
  { locale: "ne-NP", category: "free_trial_today", body: "Nabikaran: Tapaiko {label} free trial aaja ({date}) sakinchha. Paisa katna nadina aajai cancel garnuhos." },
  { locale: "en-NP", category: "cancel_deadline", body: "Nabikaran: Last day to cancel {label} is {date}, in {days} day(s). After that it may renew and charge you." },
  { locale: "en-NP", category: "cancel_deadline_today", body: "Nabikaran: Today ({date}) is the last day to cancel {label}. After today it may renew and charge you." },
  { locale: "ne-NP", category: "cancel_deadline", body: "Nabikaran: {label} cancel garne antim din {date} ho ({days} din baki). Tyaspachhi renew bhai paisa katna sakchha." },
  { locale: "ne-NP", category: "cancel_deadline_today", body: "Nabikaran: Aaja ({date}) {label} cancel garne antim din ho. Bholi dekhi renew bhai paisa katna sakchha." },
];

const GSM_EXTENDED = /[\^{}\\[\]~|€]/g;

/**
 * Make free text safe for a GSM-7 single segment: fold accents (é→e),
 * replace typographic punctuation, drop extended-table characters (they cost
 * two septets) and anything outside GSM-7. Returns "" when nothing usable is left
 * (e.g. an all-Devanagari label).
 */
export function toGsmSafe(input: string): string {
  const folded = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(GSM_EXTENDED, "");
  let out = "";
  for (const ch of folded) out += isGsm7(ch) ? ch : " ";
  return out.replace(/\s+/g, " ").trim();
}

export function sanitizeLabel(label: string, max = SMS_LABEL_MAX): string {
  const cleaned = toGsmSafe(label);
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

/** True when the label would go out unchanged (already GSM-7 and short enough). */
export function isSmsSafeLabel(label: string): boolean {
  const t = label.trim();
  return t.length > 0 && t.length <= SMS_LABEL_MAX && toGsmSafe(t) === t.replace(/\s+/g, " ");
}

function pickTemplate(templates: TemplateRow[], locale: string, category: string): TemplateRow {
  const pick = (list: TemplateRow[], loc: string, cat: string) => list.find((t) => t.locale === loc && t.category === cat);
  return (
    pick(templates, locale, category) ??
    pick(FALLBACK_TEMPLATES, locale, category) ??
    pick(templates, "en-NP", category) ??
    pick(FALLBACK_TEMPLATES, "en-NP", category)!
  );
}

function fill(body: string, label: string, days: number, date: string): string {
  return body.replaceAll("{label}", label).replaceAll("{days}", String(days)).replaceAll("{date}", date);
}

export function renderReminder(input: RenderInput, templates: TemplateRow[] = FALLBACK_TEMPLATES): RenderedMessage {
  const locale = input.locale ?? "en-NP";
  const days = Math.max(0, daysBetween(input.dueAtUtc, input.expiryAtUtc));
  const kind = hasOwnWording(input.category) ? input.category! : null;
  const category = kind ? (days === 0 ? `${kind}_today` : kind) : days === 0 ? "today" : "default";
  const tpl = pickTemplate(templates, locale, category);
  const date = formatKathmandu(input.expiryAtUtc, false);

  let label = sanitizeLabel(input.label);
  if (!label) label = sanitizeLabel(input.fallbackLabel ?? "") || "renewal";
  // Shrink the label until the whole message fits one GSM-7 segment.
  let body = fill(tpl.body, label, days, date);
  while (estimateSegments(body).segments > SMS_MAX_SEGMENTS && label.length > 3) {
    label = label.slice(0, -1).trimEnd();
    body = fill(tpl.body, label, days, date);
  }
  const estimate = estimateSegments(body);
  if (estimate.encoding !== "GSM-7" || estimate.segments > SMS_MAX_SEGMENTS) {
    throw new Error(`SMS template "${tpl.locale}/${tpl.category}" cannot fit one GSM-7 segment`);
  }
  return { body, estimate, templateCategory: category, smsLabel: label, labelAdjusted: label !== input.label.trim() };
}

/**
 * Admin template validation: must be pure GSM-7 (no extended characters), contain
 * the required placeholders, and fit one segment in the worst case
 * (30-char label, 3-digit day count, 10-char date).
 */
export function validateTemplateBody(body: string, category: "default" | "today"): { ok: true; worstCaseSeptets: number } | { ok: false; error: string } {
  if (!body.includes("{label}")) return { ok: false, error: "Template must contain {label}" };
  if (!body.includes("{date}")) return { ok: false, error: "Template must contain {date}" };
  if (category === "default" && !body.includes("{days}")) return { ok: false, error: "Default template must contain {days}" };
  const literal = body.replaceAll("{label}", "").replaceAll("{days}", "").replaceAll("{date}", "");
  if (/[{}]/.test(literal)) return { ok: false, error: "Unknown placeholder; only {label}, {days}, {date} are allowed" };
  if (!isGsm7(literal)) return { ok: false, error: "Use English or Romanized Nepali only (GSM-7 characters, no Devanagari or emoji)" };
  if (/[\^\\[\]~|€]/.test(literal)) return { ok: false, error: "Avoid ^ { } \\ [ ] ~ | € — they count double in SMS" };
  const worst = fill(body, "W".repeat(SMS_LABEL_MAX), 999, "2026-10-09");
  const est = estimateSegments(worst);
  if (est.segments > 1) return { ok: false, error: `Too long: worst case ${est.length} characters, maximum 160` };
  return { ok: true, worstCaseSeptets: est.length };
}
