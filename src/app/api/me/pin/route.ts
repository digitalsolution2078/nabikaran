import { z } from "zod";
import { handle, json, parseBody, requireUser, limit, HttpError } from "@/lib/http";
import { PinError, pinStatus, removePin, setPin } from "@/lib/auth/pin";

const toHttp = (e: unknown) => {
  if (e instanceof PinError) return new HttpError(400, e.message, e.code);
  return e;
};

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json(await pinStatus(user.id));
  });
}

const setSchema = z.object({ pin: z.string().min(4).max(6), currentPin: z.string().max(6).nullable().optional() });

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "pin:set", 10, 3600);
    const { pin, currentPin } = await parseBody(req, setSchema);
    try {
      await setPin(user.id, pin, currentPin);
    } catch (e) {
      throw toHttp(e);
    }
    return json(await pinStatus(user.id));
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "pin:set", 10, 3600);
    const { currentPin } = await parseBody(req, z.object({ currentPin: z.string().max(6).default("") }));
    try {
      await removePin(user.id, currentPin);
    } catch (e) {
      throw toHttp(e);
    }
    return json(await pinStatus(user.id));
  });
}
