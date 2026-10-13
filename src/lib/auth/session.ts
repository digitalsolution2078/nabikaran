import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { env } from "../env";
import { getDb } from "../db";
import type { Role } from "./rbac";

export interface SessionUser {
  id: string;
  phoneE164: string;
  role: Role;
  locale: string;
  displayName: string | null;
  status: string;
  email: string | null;
  uiLanguage: "ne" | "en";
  dateFormat: "BS" | "AD";
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
  return (await verifySessionClaims(token))?.sub ?? null;
}

/** Subject and issue time (seconds) of a valid session token. */
export async function verifySessionClaims(token: string): Promise<{ sub: string; iat: number } | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? { sub: payload.sub, iat: Number(payload.iat ?? 0) } : null;
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

// ---- Two-step sign-in -----------------------------------------------------------
// After the first factor (SMS code / PIN / email) an account with an authenticator
// app gets only this short "pending" cookie; the session is set after the app code.
const PENDING_COOKIE = "nb_2fa";
const PENDING_TTL = 10 * 60;

export async function setPendingTwoFactor(userId: string) {
  const token = await new SignJWT({ sub: userId, typ: "2fa" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${PENDING_TTL}s`).sign(key());
  (await cookies()).set(PENDING_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/", maxAge: PENDING_TTL });
}

export async function getPendingTwoFactor(): Promise<string | null> {
  const token = (await cookies()).get(PENDING_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return payload.typ === "2fa" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function clearPendingTwoFactor() {
  (await cookies()).set(PENDING_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 0 });
}

/**
 * Finish the first sign-in step: a full session, or (authenticator app on) the
 * pending step. Returns true when the app code is still needed.
 */
export async function startSession(userId: string): Promise<boolean> {
  const { rows } = await getDb().query("select 1 from users where id = $1 and totp_enabled_at is not null", [userId]);
  if (rows[0]) {
    await clearSessionCookie();
    await setPendingTwoFactor(userId);
    return true;
  }
  await setSessionCookie(userId);
  return false;
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(env.session.cookieName, "", { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 0 });
}

export async function loadUser(userId: string, issuedAt?: number): Promise<SessionUser | null> {
  const { rows } = await getDb().query<{
    id: string; phone_e164: string; role: Role; locale: string; display_name: string | null; status: string; email: string | null; ui_language: "ne" | "en"; date_format: "BS" | "AD";
    valid_after: number | null;
  }>("select id, phone_e164, role, locale, display_name, status, email, ui_language, date_format, floor(extract(epoch from sessions_valid_after))::float8 as valid_after from users where id = $1", [userId]);
  const r = rows[0];
  if (!r || r.status !== "active") return null;
  // "Log out all devices": sessions issued before that moment are refused.
  if (issuedAt !== undefined && r.valid_after !== null && issuedAt < Number(r.valid_after)) return null;
  return {
    id: r.id, phoneE164: r.phone_e164, role: r.role, locale: r.locale, displayName: r.display_name, status: r.status,
    email: r.email, uiLanguage: r.ui_language, dateFormat: r.date_format,
  };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(env.session.cookieName)?.value;
  if (!token) return null;
  const claims = await verifySessionClaims(token);
  if (!claims) return null;
  return loadUser(claims.sub, claims.iat);
}

/**
 * End every session of this account (all phones and browsers). With
 * `keepCurrent`, this browser gets a fresh session so the customer stays in.
 */
export async function revokeAllSessions(userId: string, opts: { keepCurrent?: boolean } = {}): Promise<void> {
  await getDb().query("update users set sessions_valid_after = now() where id = $1", [userId]);
  if (opts.keepCurrent) await setSessionCookie(userId);
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
