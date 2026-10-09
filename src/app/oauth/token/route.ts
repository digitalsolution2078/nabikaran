import { NextResponse } from "next/server";
import { exchangeToken } from "@/lib/oauth/tokens";
import { OAuthError } from "@/lib/oauth/errors";
import { checkRateLimit } from "@/lib/core/rate-limit";
import { RateLimitError } from "@/lib/core/errors";
import { getDb } from "@/lib/db";
import { corsPreflight, parseForm, withCors } from "@/lib/http";

/** RFC 6749 §3.2 token endpoint: authorization_code (+PKCE) and refresh_token grants. */
export async function POST(req: Request) {
  try {
    const form = await parseForm(req);
    await checkRateLimit(getDb(), `client:${form.client_id ?? "anon"}`, { bucket: "oauth:token", limit: 60, windowSeconds: 60 });
    const tokens = await exchangeToken(form);
    return withCors(NextResponse.json(tokens, { headers: { pragma: "no-cache" } }));
  } catch (e) {
    if (e instanceof OAuthError) {
      const headers: Record<string, string> = e.status === 401 ? { "www-authenticate": 'Basic realm="oauth"' } : {};
      return withCors(NextResponse.json(e.toJSON(), { status: e.status, headers }));
    }
    if (e instanceof RateLimitError) return withCors(NextResponse.json({ error: "invalid_request", error_description: "rate limited" }, { status: 429, headers: { "retry-after": String(e.retryAfterSeconds) } }));
    console.error(e);
    return withCors(NextResponse.json({ error: "server_error" }, { status: 500 }));
  }
}

export async function OPTIONS() {
  return corsPreflight();
}
