import { z } from "zod";
import { handle, json, parseBody, requireUser, limit } from "@/lib/http";
import { confirmEmailVerify, emailStatus, removeEmail, requestEmailVerify } from "@/lib/services/email-auth";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json(await emailStatus(user.id));
  });
}

/** POST: send a code to a new address (Pro). */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "email:verify", 6, 3600);
    const { email } = await parseBody(req, z.object({ email: z.string().max(120) }));
    const r = await requestEmailVerify(user.id, email);
    return json({ sent: true, ...r });
  });
}

/** PUT: confirm the code. */
export async function PUT(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "email:confirm", 20, 3600);
    const { email, code } = await parseBody(req, z.object({ email: z.string().max(120), code: z.string().max(10) }));
    return json(await confirmEmailVerify(user.id, email, code));
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json(await removeEmail(user.id));
  });
}
