import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { env } from "../env";
import { getDb } from "../db";

export interface SessionUser {
  id: string;
  phoneE164: string;
  role: "user" | "admin";
  locale: string;
  displayName: string | null;
  status: string;
}

const key = () => new TextEncoder().encode(env.sessionSecret());

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${env.session.ttlSeconds}s`)
    .sign(key());
}

export async function verifySession(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function setSessionCookie(userId: string) {
  const jar = await cookies();
  jar.set(env.session.cookieName, await signSession(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    path: "/",
    maxAge: env.session.ttlSeconds,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(env.session.cookieName, "", { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 0 });
}

export async function loadUser(userId: string): Promise<SessionUser | null> {
  const { rows } = await getDb().query<{
    id: string; phone_e164: string; role: "user" | "admin"; locale: string; display_name: string | null; status: string;
  }>("select id, phone_e164, role, locale, display_name, status from users where id = $1", [userId]);
  const r = rows[0];
  if (!r || r.status !== "active") return null;
  return { id: r.id, phoneE164: r.phone_e164, role: r.role, locale: r.locale, displayName: r.display_name, status: r.status };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(env.session.cookieName)?.value;
  if (!token) return null;
  const userId = await verifySession(token);
  if (!userId) return null;
  return loadUser(userId);
}

/**
 * CSRF defence for cookie-authenticated mutating requests: SameSite=Lax plus
 * an Origin/Referer check against APP_URL.
 */
export async function assertSameOrigin(): Promise<boolean> {
  const h = await headers();
  const origin = h.get("origin") ?? (h.get("referer") ? new URL(h.get("referer")!).origin : null);
  if (!origin) return !env.isProd; // non-browser clients in dev only
  try {
    return new URL(origin).host === new URL(env.appUrl).host || new URL(origin).host === h.get("host");
  } catch {
    return false;
  }
}
