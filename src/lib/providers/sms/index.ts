import { env } from "../../env";
import { AakashSmsProvider } from "./aakash";
import { MockSmsProvider } from "./mock";
import type { SmsProvider } from "./types";

let instance: SmsProvider | undefined;

export function setSmsProviderForTests(p: SmsProvider | undefined) {
  instance = p;
}

export function getSmsProvider(): SmsProvider {
  if (instance) return instance;
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
