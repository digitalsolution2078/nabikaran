import { getDb, type Db } from "../db";
import { redactPhone } from "../phone";
import { HttpError } from "./errors";
import { requireScope, type Principal } from "./principal";

export interface AccountDTO {
  displayName: string | null;
  phoneMasked: string;
  locale: string;
  timezone: string;
  memberSince: string;
  phoneVerified: boolean;
}

export async function getAccount(p: Principal, db: Db = getDb()): Promise<AccountDTO> {
  requireScope(p, "account:read");
  const { rows } = await db.query<{
    display_name: string | null; phone_e164: string; locale: string; timezone: string; created_at: string; phone_verified_at: string | null; status: string;
  }>("select display_name, phone_e164, locale, timezone, created_at, phone_verified_at, status from users where id = $1", [p.userId]);
  const u = rows[0];
  if (!u || u.status !== "active") throw new HttpError(401, "Account not active", "unauthenticated");
  return {
    displayName: u.display_name,
    phoneMasked: redactPhone(u.phone_e164),
    locale: u.locale,
    timezone: u.timezone,
    memberSince: new Date(u.created_at).toISOString(),
    phoneVerified: u.phone_verified_at !== null,
  };
}
