import { z } from "zod";
import { handle, json, parseBody, requireUser, limit } from "@/lib/http";
import { deviceCount, getVapidKeys, removePushSubscription, savePushSubscription, sendPushToUser, subscriptionSchema } from "@/lib/services/push";

/** Public VAPID key and how many devices of this user receive notifications. */
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const [keys, devices] = await Promise.all([getVapidKeys(), deviceCount(user.id)]);
    return json({ publicKey: keys.publicKey, devices });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "push:subscribe", 20, 3600);
    const { subscription } = await parseBody(req, z.object({ subscription: subscriptionSchema }));
    const devices = await savePushSubscription(user.id, subscription, req.headers.get("user-agent"));
    return json({ devices });
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const { endpoint } = await parseBody(req, z.object({ endpoint: z.string().max(1000).nullable().default(null) }));
    return json({ devices: await removePushSubscription(user.id, endpoint) });
  });
}

/** PUT = send a test notification to this user's devices. */
export async function PUT(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "push:test", 5, 3600);
    const { title, body } = await parseBody(req, z.object({ title: z.string().max(60).default("Nabikaran"), body: z.string().max(200) }));
    return json({ reached: await sendPushToUser(user.id, { title, body, url: "/dashboard", tag: "test" }) });
  });
}
