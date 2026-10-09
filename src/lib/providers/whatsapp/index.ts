import { env } from "../../env";
import { MetaWhatsAppProvider } from "./meta";
import { MockWhatsAppProvider } from "./mock";
import type { WhatsAppProvider } from "./types";

let instance: WhatsAppProvider | undefined;

export function setWhatsAppProviderForTests(p: WhatsAppProvider | undefined) {
  instance = p;
}

export function getWhatsAppProvider(): WhatsAppProvider | null {
  if (instance) return instance;
  if (env.whatsapp.provider === "meta" && env.whatsapp.accessToken) {
    instance = new MetaWhatsAppProvider(env.whatsapp);
  } else if (env.whatsapp.provider === "mock") {
    const m = new MockWhatsAppProvider();
    m.log = (l) => console.log(l);
    instance = m;
  } else {
    return null;
  }
  return instance;
}

export { whatsappAvailable } from "../../whatsapp/availability";

export type { WhatsAppProvider, WhatsAppSendInput } from "./types";
