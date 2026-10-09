import { getDb, type Db } from "../db";
import { env } from "../env";
import { SCOPES, type Scope } from "../core/principal";
import { OAuthError } from "./errors";
import { getClient, redirectUriMatches, type ClientRow } from "./clients";
import { randomToken, sha256hex } from "./pkce";

/**
 * Authorization request validation (RFC 6749 §4.1.1 + OAuth 2.1: PKCE S256
 * mandatory, exact redirect_uri, resource indicator RFC 8707 bound to the
 * MCP endpoint). Errors that may safely be sent back to the redirect_uri are
 * marked `redirectable`; the rest are shown to the user on our own page.
 */
export interface AuthorizeParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  scope?: string | null;
  state?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  resource?: string | null;
}

export interface ValidatedAuthorizeRequest {
  client: ClientRow;
  redirectUri: string;
  scopes: Scope[];
  state: string | null;
  codeChallenge: string;
  resource: string;
}

export class AuthorizeError extends OAuthError {
  constructor(error: OAuthError["error"], description: string, public readonly redirectable: boolean, public readonly redirectUri?: string, public readonly state?: string | null) {
    super(error, description);
  }
}

export function parseScopes(scope: string | null | undefined): Scope[] {
  if (!scope || !scope.trim()) return [...SCOPES];
  const parts = Array.from(new Set(scope.split(/\s+/).filter(Boolean)));
  const bad = parts.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new OAuthError("invalid_scope", `unknown scope: ${bad.join(" ")}`);
  return parts as Scope[];
}

export async function validateAuthorizeRequest(p: AuthorizeParams, db: Db = getDb()): Promise<ValidatedAuthorizeRequest> {
  const client = p.client_id ? await getClient(p.client_id, db) : null;
  if (!client || client.disabled_at) throw new AuthorizeError("invalid_client", "Unknown client", false);
  const redirectUri = p.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  if (!redirectUri || !client.redirect_uris.some((r) => redirectUriMatches(r, redirectUri))) {
    throw new AuthorizeError("invalid_redirect_uri", "redirect_uri is not registered for this client", false);
  }
  const state = p.state ?? null;
  const fail = (error: OAuthError["error"], d: string) => new AuthorizeError(error, d, true, redirectUri, state);
  if (p.response_type !== "code") throw fail("invalid_request", "response_type must be code");
  if (!p.code_challenge || !/^[A-Za-z0-9\-._~]{43,128}$/.test(p.code_challenge)) throw fail("invalid_request", "code_challenge (S256) is required");
  if ((p.code_challenge_method ?? "plain") !== "S256") throw fail("invalid_request", "code_challenge_method must be S256");
  const resource = p.resource ?? env.mcpResource;
  if (resource !== env.mcpResource) throw fail("invalid_target", `resource must be ${env.mcpResource}`);
  let scopes: Scope[];
  try {
    scopes = parseScopes(p.scope);
  } catch (e) {
    throw fail("invalid_scope", (e as Error).message);
  }
  return { client, redirectUri, scopes, state, codeChallenge: p.code_challenge, resource };
}

/** Issue a single-use authorization code after the user consented. Returns the plaintext code. */
export async function issueAuthorizationCode(req: ValidatedAuthorizeRequest, userId: string, db: Db = getDb()): Promise<string> {
  const code = randomToken(32);
  await db.query(
    `insert into oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, resource, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))`,
    [sha256hex(code), req.client.id, userId, req.redirectUri, req.scopes, req.codeChallenge, req.resource, env.oauth.codeTtlSeconds],
  );
  await db.query(
    "insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id, json_detail_redacted) values ($1,'web',$2,'oauth.consent_granted','oauth_client',$2,$3)",
    [userId, req.client.id, JSON.stringify({ scopes: req.scopes })],
  );
  return code;
}

export interface ConsumedCode {
  userId: string;
  clientId: string;
  scopes: Scope[];
  resource: string;
  redirectUri: string;
  codeChallenge: string;
}

/**
 * Atomically consume a code. Must be called inside a transaction. A code that
 * was already consumed is treated as a replay: per OAuth 2.1 §4.1.2 we revoke
 * everything issued from it (handled by the caller via family lookup).
 */
export async function consumeAuthorizationCode(tx: Db, code: string): Promise<ConsumedCode & { replayed: boolean }> {
  const { rows } = await tx.query<{
    client_id: string; user_id: string; redirect_uri: string; scopes: string[]; code_challenge: string; resource: string; expires_at: string; consumed_at: string | null;
  }>("select * from oauth_authorization_codes where code_hash = $1 for update", [sha256hex(code)]);
  const c = rows[0];
  if (!c) throw new OAuthError("invalid_grant", "unknown authorization code");
  if (c.consumed_at) {
    return { userId: c.user_id, clientId: c.client_id, scopes: c.scopes as Scope[], resource: c.resource, redirectUri: c.redirect_uri, codeChallenge: c.code_challenge, replayed: true };
  }
  if (new Date(c.expires_at).getTime() < Date.now()) throw new OAuthError("invalid_grant", "authorization code expired");
  await tx.query("update oauth_authorization_codes set consumed_at = now() where code_hash = $1", [sha256hex(code)]);
  return { userId: c.user_id, clientId: c.client_id, scopes: c.scopes as Scope[], resource: c.resource, redirectUri: c.redirect_uri, codeChallenge: c.code_challenge, replayed: false };
}
