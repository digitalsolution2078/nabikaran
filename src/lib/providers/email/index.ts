import { getDb, type Db } from "../../db";
import { getSecret } from "../../services/secrets";
import { getSetting } from "../../services/settings";

/**
 * Email sending. Resend (https://resend.com) in production; an in-memory mock
 * in development and tests (EMAIL_PROVIDER=mock).
 *
 * Outcomes:
 *  accepted  Resend took the email
 *  rejected  refused (transient = worth retrying later)
 * There is no "unknown": the same Idempotency-Key is sent on every retry of a
 * message, so Resend never delivers it twice and a lost response is simply retried.
 */
export type EmailOutcome =
  | { kind: "accepted"; providerMessageId: string; units?: number }
  | { kind: "rejected"; transient: boolean; reason: string };

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Stable per message: retries reuse it so the email is never sent twice. */
  idempotencyKey: string;
}

export interface EmailProvider {
  readonly name: string;
  send(m: EmailMessage): Promise<EmailOutcome>;
}

export class MockEmailProvider implements EmailProvider {
  readonly name = "mock-email";
  readonly sent: Array<EmailMessage & { id: string }> = [];
  private seq = 0;
  public log: (line: string) => void = () => undefined;
  async send(m: EmailMessage): Promise<EmailOutcome> {
    if (m.to.startsWith("bounce@")) return { kind: "rejected", transient: false, reason: "mock: invalid address" };
    const dup = this.sent.find((s) => s.idempotencyKey === m.idempotencyKey);
    if (dup) return { kind: "accepted", providerMessageId: dup.id };
    const id = `mock-email-${++this.seq}`;
    this.sent.push({ ...m, id });
    this.log(`[mock-email] to=${m.to} id=${id} subject=${m.subject} text=${m.text.replace(/\n/g, " ")}`);
    return { kind: "accepted", providerMessageId: id };
  }
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  constructor(private apiKey: string, private from: string, private replyTo: string | null, private fetchImpl: typeof fetch = fetch) {}

  async send(m: EmailMessage): Promise<EmailOutcome> {
    const body = JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html, reply_to: this.replyTo ?? undefined });
    let last = "no response";
    for (let i = 0; i < 2; i++) {
      try {
        const res = await this.fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": m.idempotencyKey.slice(0, 256) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
        if (res.ok && data.id) return { kind: "accepted", providerMessageId: data.id };
        last = `${res.status} ${data.name ?? ""} ${data.message ?? ""}`.trim();
        // 429 and 5xx are worth retrying later; 4xx (bad address, unverified domain, bad key) are not.
        if (res.status === 429 || res.status >= 500) continue;
        return { kind: "rejected", transient: false, reason: `Resend: ${last}` };
      } catch (e) {
        last = (e as Error).message;
      }
    }
    return { kind: "rejected", transient: true, reason: `Resend: ${last}` };
  }
}

let override: EmailProvider | null | undefined;
export function setEmailProviderForTests(p: EmailProvider | null | undefined) {
  override = p;
}

let devMock: MockEmailProvider | null = null;

/** The configured provider, or null when email is not set up (no key, no sender, or switched off). */
export async function getEmailProvider(db: Db = getDb()): Promise<EmailProvider | null> {
  if (override !== undefined) return override;
  if (process.env.EMAIL_PROVIDER === "mock") {
    if (!devMock) {
      devMock = new MockEmailProvider();
      devMock.log = (line) => console.log(line);
    }
    return devMock;
  }
  const [settings, saved] = await Promise.all([getSetting("email", db), getSecret("resend_api_key", db)]);
  const key = saved || process.env.RESEND_API_KEY || null;
  if (!settings.enabled || !key || !settings.from_email) return null;
  return new ResendEmailProvider(key, `${settings.from_name} <${settings.from_email}>`, settings.reply_to || null);
}

/** Minimal, safe HTML version of a plain-text email. */
export function textToHtml(text: string, link?: { href: string; label: string }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const paras = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const btn = link ? `<p style="margin:18px 0"><a href="${esc(link.href)}" style="background:#55239a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">${esc(link.label)}</a></p>` : "";
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#0f172a;max-width:520px">${paras}${btn}<p style="margin-top:24px;font-size:12px;color:#64748b">Nabikaran · nabikaran.org</p></div>`;
}
