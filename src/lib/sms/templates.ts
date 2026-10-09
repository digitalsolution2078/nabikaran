import { estimateSegments, isGsm7, type SegmentEstimate } from "./segments";
import { formatKathmandu, daysBetween } from "../time";

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
  const pick = (loc: string, cat: string) => templates.find((t) => t.locale === loc && t.category === cat);
  return pick(locale, category) ?? pick("en-NP", category) ?? FALLBACK_TEMPLATES.find((t) => t.locale === "en-NP" && t.category === category)!;
}

function fill(body: string, label: string, days: number, date: string): string {
  return body.replaceAll("{label}", label).replaceAll("{days}", String(days)).replaceAll("{date}", date);
}

export function renderReminder(input: RenderInput, templates: TemplateRow[] = FALLBACK_TEMPLATES): RenderedMessage {
  const locale = input.locale ?? "en-NP";
  const days = Math.max(0, daysBetween(input.dueAtUtc, input.expiryAtUtc));
  const category = days === 0 ? "today" : "default";
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
