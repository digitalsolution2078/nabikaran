import { env } from "../env";
import { getDb, type Db } from "../db";
import { getSetting } from "../services/settings";

let forced: boolean | undefined;
export function setWhatsAppAvailableForTests(v: boolean | undefined) {
  forced = v;
}

/** WhatsApp can be offered to customers only when the owner enabled it AND the server has a provider. */
export async function whatsappAvailable(db: Db = getDb()): Promise<boolean> {
  if (forced !== undefined) return forced;
  const s = await getSetting("whatsapp", db);
  if (!s.enabled) return false;
  if (env.whatsapp.provider === "mock") return true;
  return env.whatsapp.provider === "meta" && Boolean(env.whatsapp.accessToken && s.phone_number_id);
}
