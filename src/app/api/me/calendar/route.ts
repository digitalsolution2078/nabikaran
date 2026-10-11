import { z } from "zod";
import { handle, json, parseBody, requireUser, limit } from "@/lib/http";
import { disableCalendar, enableCalendar, getCalendarLink } from "@/lib/services/calendar";
import { requirePro } from "@/lib/services/plans";

/** Pro: the calendar feed link (Google Calendar, Apple Calendar, Outlook). */
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await requirePro(user.id);
    return json(await getCalendarLink(user.id));
  });
}

/** Turn on (or reset with reset: true). */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "calendar:link", 20, 3600);
    const { reset } = await parseBody(req, z.object({ reset: z.boolean().default(false) }));
    return json(await enableCalendar(user.id, { reset }));
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json(await disableCalendar(user.id));
  });
}
