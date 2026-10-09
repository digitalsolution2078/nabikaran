import { z } from "zod";
import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { cancelUnsentJobs } from "../core/reminders";
import type { Principal } from "../core/principal";

export const GROUP_KINDS = ["custom", "birthday", "anniversary"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
export const MAX_GROUPS = 50;

export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(GROUP_KINDS).default("custom"),
});

export interface GroupRow {
  id: string;
  name: string;
  kind: GroupKind;
  active: number;
  total: number;
}

/** Category, schedule and repeat defaults a group suggests for new reminders. */
export function groupDefaults(kind: GroupKind): { category: string; offsetsDays: number[]; repeatYearly: boolean; localTime: string } {
  if (kind === "birthday") return { category: "birthday", offsetsDays: [1, 0], repeatYearly: true, localTime: "08:00" };
  if (kind === "anniversary") return { category: "anniversary", offsetsDays: [7, 1, 0], repeatYearly: true, localTime: "08:00" };
  return { category: "other", offsetsDays: [30, 7, 1, 0], repeatYearly: false, localTime: "09:00" };
}

export async function listGroups(userId: string, db: Db = getDb()): Promise<GroupRow[]> {
  const { rows } = await db.query<{ id: string; name: string; kind: GroupKind; active: string; total: string }>(
    `select g.id, g.name, g.kind,
            (select count(*) from renewal_items i where i.group_id = g.id and i.status = 'active')::text as active,
            (select count(*) from renewal_items i where i.group_id = g.id and i.status <> 'deleted')::text as total
       from reminder_groups g where g.owner_user_id = $1 order by lower(g.name)`,
    [userId],
  );
  return rows.map((r) => ({ ...r, active: Number(r.active), total: Number(r.total) }));
}

export async function getGroup(userId: string, groupId: string, db: Db = getDb()): Promise<GroupRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) return null;
  return (await listGroups(userId, db)).find((g) => g.id === groupId) ?? null;
}

function uniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/** Create a group inside the caller's transaction (used by the bulk import too). */
export async function createGroupIn(tx: Db, p: Principal, input: z.infer<typeof groupInputSchema>): Promise<GroupRow> {
  const { rows: n } = await tx.query<{ n: string }>("select count(*)::text as n from reminder_groups where owner_user_id = $1", [p.userId]);
  if (Number(n[0].n) >= MAX_GROUPS) throw new HttpError(400, `You can have up to ${MAX_GROUPS} groups.`, "too_many_groups");
  const { rows: dup } = await tx.query("select 1 from reminder_groups where owner_user_id = $1 and lower(btrim(name)) = lower(btrim($2))", [p.userId, input.name]);
  if (dup[0]) throw new HttpError(409, "A group with this name already exists.", "group_exists");
  const { rows } = await tx.query<{ id: string; name: string; kind: GroupKind }>(
    "insert into reminder_groups (owner_user_id, name, kind) values ($1, $2, $3) returning id, name, kind",
    [p.userId, input.name.trim(), input.kind],
  );
  await audit(tx, p, "group.create", { type: "reminder_group", id: rows[0].id }, { kind: input.kind });
  return { ...rows[0], active: 0, total: 0 };
}

export async function createGroup(p: Principal, input: z.infer<typeof groupInputSchema>, db: Db = getDb()): Promise<GroupRow> {
  try {
    return await db.tx((tx) => createGroupIn(tx, p, input));
  } catch (e) {
    if (uniqueViolation(e)) throw new HttpError(409, "A group with this name already exists.", "group_exists");
    throw e;
  }
}

export async function updateGroup(p: Principal, groupId: string, input: z.infer<typeof groupInputSchema>, db: Db = getDb()): Promise<GroupRow> {
  try {
    return await db.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "update reminder_groups set name = $3, kind = $4, updated_at = now() where id = $1 and owner_user_id = $2 returning id",
        [groupId, p.userId, input.name.trim(), input.kind],
      );
      if (!rows[0]) throw new HttpError(404, "Group not found", "group_not_found");
      await audit(tx, p, "group.update", { type: "reminder_group", id: groupId }, { kind: input.kind });
      return (await getGroup(p.userId, groupId, tx))!;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new HttpError(409, "A group with this name already exists.", "group_exists");
    throw e;
  }
}

/**
 * Delete a group. By default its reminders stay (ungrouped). With
 * `cancelReminders`, every reminder in it is cancelled and its reserved credits
 * are released.
 */
export async function deleteGroup(p: Principal, groupId: string, opts: { cancelReminders?: boolean } = {}, db: Db = getDb()): Promise<{ cancelledReminders: number }> {
  return db.tx(async (tx) => {
    const { rows } = await tx.query("select 1 from reminder_groups where id = $1 and owner_user_id = $2 for update", [groupId, p.userId]);
    if (!rows[0]) throw new HttpError(404, "Group not found", "group_not_found");
    let cancelledReminders = 0;
    if (opts.cancelReminders) {
      const { rows: items } = await tx.query<{ id: string }>(
        "select id from renewal_items where group_id = $1 and owner_user_id = $2 and status in ('active','paused') for update",
        [groupId, p.userId],
      );
      for (const it of items) {
        await cancelUnsentJobs(tx, it.id, "cancelled");
        await tx.query("update renewal_items set status = 'cancelled', updated_at = now() where id = $1", [it.id]);
        cancelledReminders++;
      }
    }
    await tx.query("delete from reminder_groups where id = $1 and owner_user_id = $2", [groupId, p.userId]);
    await audit(tx, p, "group.delete", { type: "reminder_group", id: groupId }, { cancelledReminders });
    return { cancelledReminders };
  });
}
