import { getDb, type Db } from "../db";
import { isAdminRole } from "../auth/rbac";
import { getSetting } from "../services/settings";
import { HttpError } from "./errors";
import { readWallet } from "./wallet";

/**
 * Usage lock (sign-in fee policy): sign-in SMS fees may push a wallet below
 * zero. When the available balance falls below `min_balance` (default -5) the
 * customer can still sign in, view everything and top up, but cannot create,
 * edit or resume reminders until a top-up clears the debt.
 */
export interface LockState {
  locked: boolean;
  available: number;
  minBalance: number;
}

export async function getLockState(userId: string, db: Db = getDb()): Promise<LockState> {
  const [s, w, role] = await Promise.all([
    getSetting("signin", db),
    readWallet(userId, db),
    db.query<{ role: string }>("select role from users where id = $1", [userId]),
  ]);
  const staffExempt = isAdminRole(role.rows[0]?.role) && !s.charge_staff;
  return { locked: !staffExempt && w.available < s.min_balance, available: w.available, minBalance: s.min_balance };
}

export async function assertNotLocked(userId: string, db: Db = getDb()): Promise<void> {
  const s = await getLockState(userId, db);
  if (s.locked) {
    throw new HttpError(
      402,
      `Your balance is ${s.available} credits, below the ${s.minBalance} limit. Top up to keep using Nabikaran.`,
      "account_locked",
    );
  }
}
