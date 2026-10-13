import { env } from "../env";
import { integrationsVersion } from "../integrations";
import { KhaltiGateway } from "./khalti";
import { EsewaGateway } from "./esewa";
import { MockGateway } from "./mock";
import type { GatewayName, PaymentGateway } from "./types";

/**
 * Online payment gateways. Khalti (or the mock in development) comes from
 * PAYMENT_GATEWAY / Admin → Integrations; eSewa is switched on separately, so
 * customers can pick either at checkout.
 */
let cache: Partial<Record<GatewayName, PaymentGateway>> = {};
let forced: Partial<Record<GatewayName, PaymentGateway>> = {};
let forcedPrimary: PaymentGateway | undefined;
let builtAt = -1;

export function setPaymentGatewayForTests(g: PaymentGateway | undefined) {
  forcedPrimary = g;
  forced = g ? { [g.name]: g } : {};
}

/** Tests: add another gateway next to the primary one. */
export function addPaymentGatewayForTests(g: PaymentGateway) {
  forced = { ...forced, [g.name]: g };
}

/** The gateways a customer can choose right now. */
export function enabledGateways(): GatewayName[] {
  if (forcedPrimary || Object.keys(forced).length) return Object.keys(forced) as GatewayName[];
  const out: GatewayName[] = [];
  if (env.paymentGateway === "khalti") out.push("khalti");
  if (env.paymentGateway === "mock") out.push("mock");
  if (env.esewa.mode === "live" || env.esewa.mode === "test") out.push("esewa");
  return out;
}

function build(name: GatewayName): PaymentGateway | undefined {
  if (name === "khalti") return env.paymentGateway === "khalti" ? new KhaltiGateway(env.khalti) : undefined;
  if (name === "mock") return env.paymentGateway === "mock" ? new MockGateway(env.appUrl) : undefined;
  const e = env.esewa;
  return e.mode === "off" ? undefined : new EsewaGateway({ ...e, appUrl: env.appUrl });
}

/** A gateway by name (or the primary one), or throws when it is not switched on. */
export function getPaymentGateway(name?: GatewayName): PaymentGateway {
  if (!name) {
    if (forcedPrimary) return forcedPrimary;
    name = env.paymentGateway === "khalti" ? "khalti" : env.paymentGateway === "mock" ? "mock" : "esewa";
  }
  if (forced[name]) return forced[name]!;
  if (builtAt !== integrationsVersion()) {
    cache = {};
    builtAt = integrationsVersion();
  }
  const g = cache[name] ?? build(name);
  if (!g) throw Object.assign(new Error(`Payment method ${name} is not available`), { code: "gateway_disabled" });
  cache[name] = g;
  return g;
}

export type { PaymentGateway, LookupResult, InitiateResult, GatewayName } from "./types";
