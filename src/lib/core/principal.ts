import { ScopeError } from "./errors";

/**
 * Who is acting, through which channel, with which permissions.
 *
 * The ONLY ways to obtain a Principal are:
 *  - webPrincipal(): from a validated session cookie (src/lib/auth/session.ts)
 *  - mcpPrincipal(): from a validated OAuth access token (Phase 2)
 * Core functions never accept a bare user id from callers, so a transport
 * cannot act on behalf of a user it has not authenticated.
 */
export const SCOPES = ["account:read", "wallet:read", "reminders:read", "reminders:write"] as const;
export type Scope = (typeof SCOPES)[number];
export const ALL_SCOPES: readonly Scope[] = SCOPES;

export interface Principal {
  readonly userId: string;
  readonly via: "web" | "mcp";
  readonly scopes: readonly Scope[];
  readonly clientId?: string;
  readonly tokenId?: string;
  readonly locale: string;
}

export function webPrincipal(user: { id: string; locale: string }): Principal {
  return { userId: user.id, via: "web", scopes: ALL_SCOPES, locale: user.locale };
}

export function mcpPrincipal(input: { userId: string; locale: string; scopes: Scope[]; clientId: string; tokenId: string }): Principal {
  const scopes = input.scopes.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  return { userId: input.userId, via: "mcp", scopes, clientId: input.clientId, tokenId: input.tokenId, locale: input.locale };
}

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.includes(scope);
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!hasScope(p, scope)) throw new ScopeError(scope);
}

/** Subject string for rate limiting and audit: token for MCP, user for web. */
export function principalSubject(p: Principal): string {
  return p.via === "mcp" && p.tokenId ? `token:${p.tokenId}` : `user:${p.userId}`;
}
