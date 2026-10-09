import { estimateSegments, type SegmentEstimate } from "./segments";
import { formatKathmandu, daysBetween } from "../time";

export interface TemplateRow {
  locale: string;
  category: string;
  body: string;
}

export interface RenderInput {
  label: string;
  expiryAtUtc: Date;
  dueAtUtc: Date;
  locale?: string;
}

export interface RenderedMessage {
  body: string;
  estimate: SegmentEstimate;
  templateCategory: string;
}

/** Built-in fallbacks when the sms_templates table is unavailable. */
export const FALLBACK_TEMPLATES: TemplateRow[] = [
  { locale: "ne-NP", category: "default", body: "Nabikaran: तपाईंको {label} को म्याद {days} दिनमा सकिन्छ ({date})। समयमै नवीकरण गर्नुहोस्।" },
  { locale: "ne-NP", category: "today", body: "Nabikaran: तपाईंको {label} को म्याद आज ({date}) सकिन्छ। समयमै नवीकरण गर्नुहोस्।" },
  { locale: "en-NP", category: "default", body: "Nabikaran: Your {label} expires in {days} day(s) on {date}. Renew on time." },
  { locale: "en-NP", category: "today", body: "Nabikaran: Your {label} expires today ({date}). Renew on time." },
];

/** Labels are user-controlled; strip control chars and cap length so a label cannot inflate cost unboundedly. */
export function sanitizeLabel(label: string, max = 40): string {
  const cleaned = label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function renderReminder(input: RenderInput, templates: TemplateRow[] = FALLBACK_TEMPLATES): RenderedMessage {
  const locale = input.locale ?? "ne-NP";
  const days = Math.max(0, daysBetween(input.dueAtUtc, input.expiryAtUtc));
  const category = days === 0 ? "today" : "default";
  const pick = (loc: string, cat: string) => templates.find((t) => t.locale === loc && t.category === cat);
  const tpl = pick(locale, category) ?? pick("ne-NP", category) ?? FALLBACK_TEMPLATES.find((t) => t.category === category)!;
  const body = tpl.body
    .replaceAll("{label}", sanitizeLabel(input.label))
    .replaceAll("{days}", String(days))
    .replaceAll("{date}", formatKathmandu(input.expiryAtUtc, false));
  return { body, estimate: estimateSegments(body), templateCategory: category };
}
