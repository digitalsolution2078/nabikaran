import { env } from "../env";
import { KhaltiGateway } from "./khalti";
import { MockGateway } from "./mock";
import type { PaymentGateway } from "./types";

let instance: PaymentGateway | undefined;

export function setPaymentGatewayForTests(g: PaymentGateway | undefined) {
  instance = g;
}

export function getPaymentGateway(): PaymentGateway {
  if (instance) return instance;
  instance = env.paymentGateway === "khalti" ? new KhaltiGateway(env.khalti) : new MockGateway(env.appUrl);
  return instance;
}

export type { PaymentGateway, LookupResult, InitiateResult } from "./types";
