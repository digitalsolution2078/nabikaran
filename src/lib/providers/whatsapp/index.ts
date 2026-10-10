import { env } from "../../env";
import { integrationsVersion } from "../../integrations";
import { MetaWhatsAppProvider } from "./meta";
import { MockWhatsAppProvider } from "./mock";
import type { WhatsAppProvider } from "./types";

let instance: WhatsAppProvider | undefined;
let forced: WhatsAppProvider | undefined;
let builtAt = -1;

export function setWhatsAppProviderForTests(p: WhatsAppProvider | undefined) {
  forced = p;
}

export function getWhatsAppProvider(): WhatsAppProvider | null {
  if (forced) return forced;
  if (instance && builtAt === integrationsVersion()) return instance;
  builtAt = integrationsVersion();
  instance = undefined;
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
