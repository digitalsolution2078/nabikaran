"use client";
import type { MessageKey } from "@/lib/i18n/dict";
import { usePrefs } from "./Prefs";

const TONE: Record<string, "ok" | "warn" | "bad" | "info" | ""> = {
  planned: "info", awaiting_credits: "warn", scheduled: "info", sending: "info", submitted: "ok", delivered: "ok",
  failed: "bad", unknown: "warn", cancelled: "", active: "ok", paused: "warn", paid: "ok", pending: "warn",
  awaiting_payment: "warn", approved: "ok", rejected: "bad", initiated: "", expired: "", refunded: "bad",
  user: "", admin: "info", super_admin: "ok", closed: "bad", suspended: "bad",
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = usePrefs();
  const key = `status.${status}` as MessageKey;
  const label = t(key);
  return <span className={`badge ${TONE[status] ?? ""}`}>{label === key ? status.replace(/_/g, " ") : label}</span>;
}
