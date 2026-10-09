import type { ReportResult, SendOutcome, SmsProvider } from "./types";

/**
 * Aakash SMS adapter (https://aakashsms.com/documentation/).
 *
 * Request shape as documented at time of writing (v3):
 *   POST {sendUrl}  form/json: auth_token, to, text
 *   Response: { error: boolean, message: string, data: { valid: [{ id, mobile, text, credit, network }], invalid: [...] } }
 *
 * The exact field names must be re-verified against the written quote /
 * sandbox before launch (PRD §14). Everything vendor-specific is confined to
 * this file; the dispatcher only sees normalized outcomes.
 */
export interface AakashConfig {
  authToken: string;
  sendUrl: string;
  reportUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type AakashSendResponse = {
  error?: boolean;
  message?: string;
  data?: {
    valid?: Array<{ id?: string | number; mobile?: string; credit?: number | string; status?: string }>;
    invalid?: Array<{ mobile?: string; reason?: string }>;
  };
};

export class AakashSmsProvider implements SmsProvider {
  readonly name = "aakash";
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: AakashConfig) {
    if (!cfg.authToken) throw new Error("AAKASH_AUTH_TOKEN missing");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async send(input: { to: string; text: string; idempotencyKey: string }): Promise<SendOutcome> {
    const to = input.to.replace(/^\+977/, "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.sendUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ auth_token: this.cfg.authToken, to, text: input.text }),
        signal: ctrl.signal,
      });
    } catch (e) {
      // Network error or timeout: we do not know whether the provider accepted it.
      return { kind: "unknown", reason: `network: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }

    let body: AakashSendResponse | undefined;
    const text = await res.text();
    try {
      body = JSON.parse(text) as AakashSendResponse;
    } catch {
      body = undefined;
    }

    if (res.status === 401 || res.status === 403) {
      return { kind: "rejected", transient: false, reason: `auth ${res.status}`, raw: text };
    }
    if (res.status === 429 || res.status >= 500) {
      // Request may or may not have been processed; a 5xx after processing is possible.
      return res.status === 429
        ? { kind: "rejected", transient: true, reason: "rate limited", raw: text }
        : { kind: "unknown", reason: `http ${res.status}`, raw: text };
    }
    if (!body) return { kind: "unknown", reason: "unparseable response", raw: text };

    if (body.error) {
      const msg = (body.message ?? "").toLowerCase();
      const transient = /credit|balance|busy|try again|temporar/.test(msg);
      return { kind: "rejected", transient, reason: body.message ?? "provider error", raw: body };
    }
    const valid = body.data?.valid?.[0];
    if (valid?.id !== undefined) {
      const units = valid.credit !== undefined ? Number(valid.credit) : undefined;
      return {
        kind: "accepted",
        providerMessageId: String(valid.id),
        units: Number.isFinite(units) && units! > 0 ? units : undefined,
        raw: body,
      };
    }
    const invalid = body.data?.invalid?.[0];
    if (invalid) return { kind: "rejected", transient: false, reason: invalid.reason ?? "invalid destination", raw: body };
    return { kind: "unknown", reason: "no message id in response", raw: body };
  }

  async report(ids: string[]): Promise<ReportResult[]> {
    if (ids.length === 0) return [];
    const res = await this.fetchImpl(this.cfg.reportUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ auth_token: this.cfg.authToken, ids: ids.join(",") }),
    });
    if (!res.ok) return ids.map((id) => ({ providerMessageId: id, status: "unknown" as const }));
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id?: string | number; status?: string; credit?: number | string }>;
    };
    const rows = body.data ?? [];
    return ids.map((id) => {
      const r = rows.find((x) => String(x.id) === id);
      if (!r) return { providerMessageId: id, status: "unknown" as const };
      const s = (r.status ?? "").toLowerCase();
      const status: ReportResult["status"] = /deliver/.test(s)
        ? "delivered"
        : /fail|reject|expired|undeliver/.test(s)
          ? "failed"
          : /pending|queue|sent|submitted/.test(s)
            ? "pending"
            : "unknown";
      const units = r.credit !== undefined ? Number(r.credit) : undefined;
      return { providerMessageId: id, status, units: Number.isFinite(units) ? units : undefined, raw: r };
    });
  }
}
