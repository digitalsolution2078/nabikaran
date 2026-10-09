import { NextResponse } from "next/server";
import { processWebhook, verifySubscription } from "@/lib/whatsapp/webhook";
import { getDb } from "@/lib/db";
import { clientIp, limit } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Meta webhook verification handshake. */
export async function GET(req: Request) {
  const challenge = verifySubscription(new URL(req.url).searchParams);
  await getDb()
    .query("insert into whatsapp_webhook_events (signature_valid, kind, status) values ($1, 'verify', $2)", [challenge !== null, challenge !== null ? "verified" : "rejected"])
    .catch(() => undefined);
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/** Status updates (sent/delivered/read/failed) and inbound messages. Signature-checked. */
export async function POST(req: Request) {
  try {
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "webhook:whatsapp", 1200, 60);
  } catch {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  const r = await processWebhook(raw, req.headers.get("x-hub-signature-256"));
  if (!r.ok) return NextResponse.json({ error: "invalid signature or payload" }, { status: 401 });
  return NextResponse.json({ ok: true });
}
