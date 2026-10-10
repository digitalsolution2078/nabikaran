import { env } from "../env";
import { integrationsVersion } from "../integrations";
import { KhaltiGateway } from "./khalti";
import { MockGateway } from "./mock";
import type { PaymentGateway } from "./types";

let instance: PaymentGateway | undefined;
let forced: PaymentGateway | undefined;
let builtAt = -1;

export function setPaymentGatewayForTests(g: PaymentGateway | undefined) {
  forced = g;
}

export function getPaymentGateway(): PaymentGateway {
  if (forced) return forced;
  if (instance && builtAt === integrationsVersion()) return instance;
  builtAt = integrationsVersion();
  instance = env.paymentGateway === "khalti" ? new KhaltiGateway(env.khalti) : new MockGateway(env.appUrl);
  return instance;
}

export type { PaymentGateway, LookupResult, InitiateResult } from "./types";
