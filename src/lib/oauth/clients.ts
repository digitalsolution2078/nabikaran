import { getDb, type Db } from "../db";
import { OAuthError } from "./errors";
import { randomToken, sha256hex } from "./pkce";
import { SCOPES } from "../core/principal";

/**
 * Dynamic client registration (RFC 7591). MCP clients (ChatGPT, Claude,
 * Inspector) register themselves; registrations are public clients unless
 * they ask for client_secret_post. Redirect URIs are validated here and
 * exact-matched at authorization time (loopback may vary its port, RFC 8252 §7.3).
 */
export interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none" | "client_secret_post";
  client_secret_hash: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  disabled_at: string | null;
  created_at: string;
}

export interface RegistrationRequest {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
  client_uri?: unknown;
  logo_uri?: unknown;
  software_id?: unknown;
}

export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  // Private-use URI schemes for native apps (RFC 8252 §7.1), e.g. "com.example.app:/callback".
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && u.protocol !== "javascript:" && u.protocol !== "data:" && u.protocol !== "file:";
}

export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    const loopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
    return a.protocol === "http:" && b.protocol === "http:" && loopback(a.hostname) && loopback(b.hostname) && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

export async function registerClient(
  req: RegistrationRequest,
  meta: { ipHash?: string | null } = {},
  db: Db = getDb(),
): Promise<{ client: ClientRow; clientSecret?: string }> {
  const name = typeof req.client_name === "string" ? req.client_name.trim().slice(0, 100) : "";
  if (!name) throw new OAuthError("invalid_client_metadata", "client_name is required");
  const uris = Array.isArray(req.redirect_uris) ? req.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (uris.length === 0 || uris.length > 10) throw new OAuthError("invalid_redirect_uri", "1-10 redirect_uris required");
  for (const u of uris) if (!isAllowedRedirectUri(u)) throw new OAuthError("invalid_redirect_uri", `redirect_uri not allowed: ${u}`);
  const method = req.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";
  if (req.token_endpoint_auth_method !== undefined && req.token_endpoint_auth_method !== "none" && req.token_endpoint_auth_method !== "client_secret_post") {
    throw new OAuthError("invalid_client_metadata", "unsupported token_endpoint_auth_method");
  }
  const grants = Array.isArray(req.grant_types) ? (req.grant_types as unknown[]) : ["authorization_code", "refresh_token"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw new OAuthError("invalid_client_metadata", "only authorization_code and refresh_token grants are supported");
  if (Array.isArray(req.response_types) && (req.response_types as unknown[]).some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "only response_type=code is supported");
  if (typeof req.scope === "string") {
    const bad = req.scope.split(/\s+/).filter(Boolean).filter((s) => !(SCOPES as readonly string[]).includes(s));
    if (bad.length) throw new OAuthError("invalid_client_metadata", `unknown scope: ${bad.join(" ")}`);
  }
  const url = (v: unknown) => (typeof v === "string" && /^https:\/\//.test(v) ? v.slice(0, 500) : null);

  const id = `nb_${randomToken(18)}`;
  const clientSecret = method === "client_secret_post" ? randomToken(32) : undefined;
  const { rows } = await db.query<ClientRow>(
    `insert into oauth_clients (id, name, redirect_uris, token_endpoint_auth_method, client_secret_hash, client_uri, logo_uri, software_id, registration_ip_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [id, name, uris, method, clientSecret ? sha256hex(clientSecret) : null, url(req.client_uri), url(req.logo_uri), typeof req.software_id === "string" ? req.software_id.slice(0, 100) : null, meta.ipHash ?? null],
  );
  await db.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('system','oauth.client_registered','oauth_client',$1,$2)", [
    id, JSON.stringify({ name, redirect_uris: uris, method }),
  ]);
  return { client: rows[0], clientSecret };
}

export async function getClient(clientId: string, db: Db = getDb()): Promise<ClientRow | null> {
  if (!clientId || clientId.length > 64) return null;
  const { rows } = await db.query<ClientRow>("select * from oauth_clients where id = $1", [clientId]);
  return rows[0] ?? null;
}

/** Validate a client for the token/revocation endpoints. Public clients present only client_id. */
export async function authenticateClient(clientId: string | undefined, clientSecret: string | undefined, db: Db = getDb()): Promise<ClientRow> {
  const client = clientId ? await getClient(clientId, db) : null;
  if (!client || client.disabled_at) throw new OAuthError("invalid_client", "unknown client", 401);
  if (client.token_endpoint_auth_method === "client_secret_post") {
    if (!clientSecret || !client.client_secret_hash || sha256hex(clientSecret) !== client.client_secret_hash) {
      throw new OAuthError("invalid_client", "client authentication failed", 401);
    }
  }
  return client;
}

export function clientMetadataResponse(client: ClientRow, clientSecret?: string) {
  return {
    client_id: client.id,
    client_name: client.name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    ...(client.client_uri ? { client_uri: client.client_uri } : {}),
    ...(client.logo_uri ? { logo_uri: client.logo_uri } : {}),
  };
}
