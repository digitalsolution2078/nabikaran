import { NextResponse } from "next/server";
import { revokeToken } from "@/lib/oauth/tokens";
import { OAuthError } from "@/lib/oauth/errors";
import { corsPreflight, parseForm, withCors } from "@/lib/http";

/** RFC 7009. Returns 200 whether or not the token existed. */
export async function POST(req: Request) {
  try {
    await revokeToken(await parseForm(req));
    return withCors(new NextResponse(null, { status: 200 }));
  } catch (e) {
    if (e instanceof OAuthError) return withCors(NextResponse.json(e.toJSON(), { status: e.status }));
    console.error(e);
    return withCors(NextResponse.json({ error: "server_error" }, { status: 500 }));
  }
}

export async function OPTIONS() {
  return corsPreflight();
}
