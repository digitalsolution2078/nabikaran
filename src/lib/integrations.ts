/**
 * Provider credentials and modes that a super admin set in Admin → Integrations.
 * Kept in memory (loaded from the database at start-up, every 30 s and right
 * after a change) so the synchronous `env` getters can use them. A value set in
 * the admin panel wins; an empty one falls back to the server environment.
 * Pure module: no database or provider imports.
 */
export interface IntegrationOverrides {
  smsProvider?: string;
  aakashAuthToken?: string;
  paymentGateway?: string;
  khaltiSecretKey?: string;
  khaltiBaseUrl?: string;
  fonepayMode?: string;
  fonepayMerchantCode?: string;
  fonepayUsername?: string;
  fonepayPassword?: string;
  fonepaySecretKey?: string;
  whatsappProvider?: string;
  whatsappAccessToken?: string;
  whatsappAppSecret?: string;
  whatsappVerifyToken?: string;
}

let overrides: IntegrationOverrides = {};
let version = 0;
let fingerprint = "";

export function getIntegrationOverrides(): IntegrationOverrides {
  return overrides;
}

/** Bumps the version when anything changed, so provider singletons rebuild. */
export function setIntegrationOverrides(next: IntegrationOverrides): boolean {
  const fp = JSON.stringify(Object.entries(next).filter(([, v]) => v).sort());
  if (fp === fingerprint) return false;
  overrides = { ...next };
  fingerprint = fp;
  version++;
  return true;
}

export function integrationsVersion(): number {
  return version;
}
