import { env } from "../../env";
import { integrationsVersion } from "../../integrations";
import { AakashSmsProvider } from "./aakash";
import { MockSmsProvider } from "./mock";
import { estimateSegments } from "../../sms/segments";
import { recordUsage, recordUsageToDb, type UsageRecorder } from "../usage";
import type { SmsProvider } from "./types";

let instance: SmsProvider | undefined;
let forced: SmsProvider | undefined;
let builtAt = -1;

export function setSmsProviderForTests(p: SmsProvider | undefined) {
  forced = p;
}

/**
 * Wraps a provider so every SMS that is not a reminder (sign-in codes, nudges,
 * low-credit alerts, welcome and test messages) is counted for Admin → Message usage.
 */
export function meteredSmsProvider(inner: SmsProvider, record: UsageRecorder = recordUsageToDb): SmsProvider {
  return {
    name: inner.name,
    report: (ids) => inner.report(ids),
    ...(inner.findByClientRef ? { findByClientRef: (k: string) => inner.findByClientRef!(k) } : {}),
    ...(inner.balance ? { balance: () => inner.balance!() } : {}),
    async send(input) {
      const out = await inner.send(input);
      const units = out.kind === "accepted" && out.units !== undefined ? out.units : null;
      await recordUsage(record, { channel: "sms", key: input.idempotencyKey, provider: inner.name, outcome: out.kind, segments: estimateSegments(input.text).segments, units });
      return out;
    },
  };
}

export function getSmsProvider(): SmsProvider {
  if (forced) return forced;
  // Rebuilt when a super admin changes the SMS settings in Admin → Integrations.
  if (instance && builtAt === integrationsVersion()) return instance;
  builtAt = integrationsVersion();
  if (env.smsProvider === "aakash") {
    instance = meteredSmsProvider(new AakashSmsProvider(env.aakash));
  } else {
    const mock = new MockSmsProvider();
    // On a real production domain the mock must never print sign-in codes into the logs.
    const realProd = env.isProd && !/localhost|127\.0\.0\.1/.test(env.appUrl);
    if (realProd) console.warn("[sms] SMS_PROVIDER is mock in production: no SMS is delivered. Set Aakash in Admin → Integrations.");
    mock.log = (line) => console.log(realProd ? line.replace(/\d{4,}/g, "****") : line);
    instance = meteredSmsProvider(mock);
  }
  return instance;
}

export type { SmsProvider, SendOutcome, ReportResult, ProviderBalance } from "./types";
