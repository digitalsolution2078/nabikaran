import { NextResponse } from "next/server";
import { registerClient } from "@/lib/oauth/clients";
import { clientMetadataResponse } from "@/lib/oauth/clients";
import { OAuthError } from "@/lib/oauth/errors";
import { checkRateLimit } from "@/lib/core/rate-limit";
import { RateLimitError } from "@/lib/core/errors";
import { getDb } from "@/lib/db";
import { hashIp } from "@/lib/auth/otp";
import { clientIp, corsPreflight, withCors } from "@/lib/http";

/** RFC 7591 dynamic client registration. Open (no auth), rate limited per IP. */
export async function POST(req: Request) {
  try {
    const ipHash = hashIp(clientIp(req));
    await checkRateLimit(getDb(), `ip:${ipHash ?? "unknown"}`, { bucket: "oauth:register", limit: 10, windowSeconds: 3600 });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new OAuthError("invalid_client_metadata", "JSON body required");
    const { client, clientSecret } = await registerClient(body, { ipHash });
    return withCors(NextResponse.json(clientMetadataResponse(client, clientSecret), { status: 201 }));
  } catch (e) {
    if (e instanceof OAuthError) return withCors(NextResponse.json(e.toJSON(), { status: e.status }));
    if (e instanceof RateLimitError) return withCors(NextResponse.json({ error: "invalid_request", error_description: "rate limited" }, { status: 429, headers: { "retry-after": String(e.retryAfterSeconds) } }));
    console.error(e);
    return withCors(NextResponse.json({ error: "server_error" }, { status: 500 }));
  }
}

export async function OPTIONS() {
  return corsPreflight();
}
