import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { assertSameOrigin, getCurrentUser, type SessionUser } from "./auth/session";
import { env } from "./env";
import { HttpError, RateLimitError } from "./core/errors";
import { webPrincipal, type Principal } from "./core/principal";
import { can, isAdminRole, type Permission } from "./auth/rbac";

export { HttpError };

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function errorResponse(e: unknown) {
  if (e instanceof RateLimitError) {
    return json({ error: e.message, code: e.code }, { status: 429, headers: { "retry-after": String(e.retryAfterSeconds) } });
  }
  if (e instanceof HttpError) return json({ error: e.message, code: e.code, ...(e.detail ? { detail: e.detail } : {}) }, { status: e.status });
  if (e instanceof ZodError) return json({ error: "Invalid input", issues: e.issues }, { status: 400 });
  const code = (e as { code?: string })?.code;
  if (code) return json({ error: (e as Error).message, code }, { status: 400 });
  console.error(e);
  return json({ error: "Internal error" }, { status: 500 });
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const body = await req.json().catch(() => {
    throw new HttpError(400, "Body must be JSON");
  });
  return schema.parse(body);
}

export async function requireUser(req: Request): Promise<SessionUser> {
  if (req.method !== "GET" && req.method !== "HEAD" && !(await assertSameOrigin())) {
    throw new HttpError(403, "Cross-site request blocked", "csrf");
  }
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Sign in required", "unauthenticated");
  return user;
}

/** Web transport → core Principal (all scopes; identity from the session cookie only). */
export async function requirePrincipal(req: Request): Promise<{ user: SessionUser; principal: Principal }> {
  const user = await requireUser(req);
  return { user, principal: webPrincipal(user) };
}

export async function requireAdmin(req: Request): Promise<SessionUser> {
  const user = await requireUser(req);
  if (!isAdminRole(user.role)) throw new HttpError(403, "Admin only", "forbidden");
  return user;
}

/** Admin with a specific permission (see src/lib/auth/rbac.ts). */
export async function requirePermission(req: Request, permission: Permission): Promise<SessionUser> {
  const user = await requireAdmin(req);
  if (!can(user.role, permission)) throw new HttpError(403, `Missing permission ${permission}`, "forbidden");
  return user;
}

/** Internal worker routes are authenticated with a bearer token, never a cookie. */
export function requireWorker(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== env.workerToken()) throw new HttpError(401, "Worker token required", "unauthenticated");
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

/** Optional client-supplied idempotency key (header or body field). */
export function idempotencyKeyFrom(req: Request, body?: { idempotencyKey?: string | null }): string | null {
  const h = req.headers.get("idempotency-key");
  const k = (h ?? body?.idempotencyKey ?? "").trim();
  return k ? k.slice(0, 64) : null;
}

/** OAuth endpoints are called cross-origin by browser-based MCP clients (e.g. Inspector); they carry no cookies. */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  res.headers.set("cache-control", "no-store");
  return res;
}

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Parse application/x-www-form-urlencoded or JSON bodies into a flat string record. */
export async function parseForm(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    return out;
  }
  const text = await req.text();
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Per-subject fixed-window limit (Postgres-backed, survives restarts).
 * subject: "user:<id>" or "ip:<ip>". Throws RateLimitError → HTTP 429 with Retry-After.
 */
export async function limit(subject: string, bucket: string, max: number, windowSeconds: number): Promise<void> {
  const { checkRateLimit } = await import("./core/rate-limit");
  const { getDb } = await import("./db");
  await checkRateLimit(getDb(), subject, { bucket, limit: max, windowSeconds });
}
