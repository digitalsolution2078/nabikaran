import { env } from "../../env";
import { integrationsVersion } from "../../integrations";
import { AakashSmsProvider } from "./aakash";
import { MockSmsProvider } from "./mock";
import type { SmsProvider } from "./types";

let instance: SmsProvider | undefined;
let forced: SmsProvider | undefined;
let builtAt = -1;

export function setSmsProviderForTests(p: SmsProvider | undefined) {
  forced = p;
}

export function getSmsProvider(): SmsProvider {
  if (forced) return forced;
  // Rebuilt when a super admin changes the SMS settings in Admin → Integrations.
  if (instance && builtAt === integrationsVersion()) return instance;
  builtAt = integrationsVersion();
  if (env.smsProvider === "aakash") {
    instance = new AakashSmsProvider(env.aakash);
  } else {
    const mock = new MockSmsProvider();
    mock.log = (line) => console.log(line);
    instance = mock;
  }
  return instance;
}

export type { SmsProvider, SendOutcome, ReportResult } from "./types";
