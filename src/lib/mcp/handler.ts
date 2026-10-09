import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyAccessToken, type VerifyFailure } from "../oauth/tokens";
import { wwwAuthenticate } from "../oauth/metadata";
import { env } from "../env";
import { createMcpServer } from "./server";
import { countEvent } from "../core/rate-limit";
import { getDb } from "../db";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
  "access-control-max-age": "86400",
};

const MAX_BODY_BYTES = 64 * 1024;

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...CORS, ...extra })) headers.set(k, v);
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function unauthorized(reason: VerifyFailure): Response {
  const description: Record<VerifyFailure, string> = {
    missing: "Bearer token required",
    invalid: "Token not recognised",
    expired: "Token expired",
    revoked: "Token revoked",
    wrong_resource: "Token was issued for a different resource",
    account_inactive: "Account is not active",
  };
  return withHeaders(
    new Response(JSON.stringify({ error: "invalid_token", error_description: description[reason] }), { status: 401, headers: { "content-type": "application/json" } }),
    { "www-authenticate": wwwAuthenticate(reason === "missing" ? undefined : description[reason]) },
  );
}

/**
 * Streamable HTTP MCP endpoint (stateless: every request carries the bearer
 * token; no server-side session). One McpServer + transport per request keeps
 * this safe on serverless and horizontally scalable.
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    return withHeaders(new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST, DELETE, OPTIONS" } }));
  }
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return withHeaders(new Response("Payload Too Large", { status: 413 }));

  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? null;
  const verified = await verifyAccessToken(token);
  if (!verified.ok) {
    await countEvent(getDb(), `mcp:401:${verified.reason}`);
    return unauthorized(verified.reason);
  }
  const { principal } = verified;

  // Stateless mode cannot serve the standalone GET stream; tell clients so.
  if (req.method === "GET") return withHeaders(new Response("Method Not Allowed", { status: 405, headers: { allow: "POST, DELETE, OPTIONS" } }));
  if (req.method === "DELETE") return withHeaders(new Response(null, { status: 204 }));

  const authInfo: AuthInfo = {
    token: "redacted",
    clientId: principal.clientId ?? "unknown",
    scopes: [...principal.scopes],
    resource: new URL(env.mcpResource),
    extra: { principal },
  };

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req, { authInfo });
    return withHeaders(res);
  } finally {
    // Release the per-request server once the response body has been produced.
    void server.close().catch(() => undefined);
  }
}
