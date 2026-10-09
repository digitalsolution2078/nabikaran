import { formatKathmandu, daysBetween } from "../time";

/**
 * WhatsApp reminders use Meta-APPROVED template messages (business-initiated
 * messages outside a 24-hour session must be templates). We never send free
 * text: we send the approved template name + language + three body
 * parameters, and show customers `body_preview` with the parameters filled in.
 *   {{1}} = document label, {{2}} = days left, {{3}} = expiry date (YYYY-MM-DD, Nepal time)
 */
export interface WaTemplateRow {
  locale: string;
  category: string;
  meta_name: string;
  meta_language: string;
  body_preview: string;
}

export const WA_LABEL_MAX = 60;

export const FALLBACK_WA_TEMPLATES: WaTemplateRow[] = [
  { locale: "en-NP", category: "default", meta_name: "nabikaran_renewal_reminder", meta_language: "en", body_preview: "Nabikaran reminder: your {{1}} expires in {{2}} day(s) on {{3}}. Please renew it on time." },
  { locale: "en-NP", category: "today", meta_name: "nabikaran_renewal_due_today", meta_language: "en", body_preview: "Nabikaran reminder: your {{1}} expires today ({{3}}). Please renew it on time." },
];

export interface RenderedWhatsApp {
  templateName: string;
  language: string;
  params: [string, string, string];
  preview: string;
  templateCategory: "default" | "today";
}

/** WhatsApp parameters may not contain newlines, tabs or 4+ consecutive spaces (Meta rule). */
export function cleanWaParam(s: string, max = WA_LABEL_MAX): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
}

function pick(rows: WaTemplateRow[], locale: string, category: string): WaTemplateRow {
  return (
    rows.find((r) => r.locale === locale && r.category === category) ??
    rows.find((r) => r.locale === "en-NP" && r.category === category) ??
    FALLBACK_WA_TEMPLATES.find((r) => r.category === category)!
  );
}

export function renderWhatsApp(
  input: { label: string; fallbackLabel?: string; expiryAtUtc: Date; dueAtUtc: Date; locale?: string },
  rows: WaTemplateRow[] = FALLBACK_WA_TEMPLATES,
): RenderedWhatsApp {
  const days = Math.max(0, daysBetween(input.dueAtUtc, input.expiryAtUtc));
  const category = days === 0 ? "today" : "default";
  const tpl = pick(rows, input.locale ?? "en-NP", category);
  const label = cleanWaParam(input.label) || cleanWaParam(input.fallbackLabel ?? "") || "renewal";
  const date = formatKathmandu(input.expiryAtUtc, false);
  const params: [string, string, string] = [label, String(days), date];
  const preview = tpl.body_preview.replaceAll("{{1}}", params[0]).replaceAll("{{2}}", params[1]).replaceAll("{{3}}", params[2]);
  return { templateName: tpl.meta_name, language: tpl.meta_language, params, preview, templateCategory: category };
}

/** Admin validation for a template mapping. */
export function validateWaTemplate(t: { meta_name: string; meta_language: string; body_preview: string; category: string }): string | null {
  if (!/^[a-z0-9_]{1,512}$/.test(t.meta_name)) return "Template name must be lowercase letters, digits and underscores (as created in Meta)";
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(t.meta_language)) return "Language must be a Meta language code such as en, en_US or ne";
  if (!t.body_preview.includes("{{1}}") || !t.body_preview.includes("{{3}}")) return "Preview must contain {{1}} (label) and {{3}} (date)";
  if (t.category === "default" && !t.body_preview.includes("{{2}}")) return "Default template preview must contain {{2}} (days)";
  if (/\{\{[4-9]\}\}/.test(t.body_preview)) return "Only {{1}}, {{2}} and {{3}} are supported";
  return null;
}
