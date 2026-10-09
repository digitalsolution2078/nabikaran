"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

export function RenewalActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const { t } = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needTopup, setNeedTopup] = useState<number | null>(null);
  async function act(action: "pause" | "resume" | "cancel" | "delete") {
    if ((action === "cancel" || action === "delete") && !confirm(t("rem.confirmCancel"))) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "delete") {
        await api(`/api/renewals/${id}`, { method: "DELETE" });
        router.push("/renewals");
      } else {
        await api(`/api/renewals/${id}`, { method: "PATCH", json: { action, idempotencyKey: crypto.randomUUID() } });
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && (e.code === "insufficient_credits" || e.code === "account_locked")) setNeedTopup(Math.max(20, e.detail?.shortfallCredits ?? 20));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="row">
      {status === "active" && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act("pause")}>{t("rem.pause")}</button>}
      {status === "paused" && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act("resume")}>{t("rem.resume")}</button>}
      {status !== "cancelled" && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act("cancel")}>{t("rem.cancel")}</button>}
      <button className="btn btn-ghost btn-sm" style={{ color: "var(--bad)" }} disabled={busy} onClick={() => act("delete")}><Icon name="x" size={14} /> {t("rem.delete")}</button>
      {error && <span className="field-error" role="alert">{error}</span>}
      {needTopup !== null && <Link href={`/wallet?amount=${needTopup}`} className="btn btn-accent btn-sm"><Icon name="wallet" size={14} /> {t("lock.cta")}</Link>}
    </div>
  );
}
