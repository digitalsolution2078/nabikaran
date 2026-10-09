import { NextResponse } from "next/server";
import { getCurrentUser, assertSameOrigin } from "@/lib/auth/session";
import { validateAuthorizeRequest, issueAuthorizationCode, AuthorizeError } from "@/lib/oauth/codes";
import { checkRateLimit } from "@/lib/core/rate-limit";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Consent decision (same-origin form POST from /oauth/authorize). Re-validates
 * every parameter server-side; the hidden fields are not trusted on their own.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v ? v : null;
  };
  if (!(await assertSameOrigin())) return NextResponse.json({ error: "csrf" }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", env.appUrl));

  let validated;
  try {
    validated = await validateAuthorizeRequest({
      response_type: get("response_type"),
      client_id: get("client_id"),
      redirect_uri: get("redirect_uri"),
      scope: get("scope"),
      state: get("state"),
      code_challenge: get("code_challenge"),
      code_challenge_method: get("code_challenge_method"),
      resource: get("resource"),
    });
  } catch (e) {
    if (e instanceof AuthorizeError && e.redirectable && e.redirectUri) {
      const u = new URL(e.redirectUri);
      u.searchParams.set("error", e.error);
      if (e.state) u.searchParams.set("state", e.state);
      return NextResponse.redirect(u);
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const target = new URL(validated.redirectUri);
  if (validated.state) target.searchParams.set("state", validated.state);
  if (get("decision") !== "allow") {
    target.searchParams.set("error", "access_denied");
    return NextResponse.redirect(target, 303);
  }
  await checkRateLimit(getDb(), `user:${user.id}`, { bucket: "oauth:authorize", limit: 30, windowSeconds: 3600 });
  const code = await issueAuthorizationCode(validated, user.id);
  target.searchParams.set("code", code);
  target.searchParams.set("iss", env.oauthIssuer.replace(/\/$/, ""));
  return NextResponse.redirect(target, 303);
}
