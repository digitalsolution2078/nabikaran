"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

export function QrSubmit({ requestId }: { requestId: string }) {
  const router = useRouter();
  const { t } = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/topups/manual/${requestId}`, { method: "POST", body: form, credentials: "same-origin" });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(data.error ?? t("common.error"));
      setBusy(false);
      return;
    }
    router.refresh();
  }

  async function cancel() {
    if (!confirm(`${t("qr.cancel")}?`)) return;
    await fetch(`/api/topups/manual/${requestId}`, { method: "DELETE", credentials: "same-origin" });
    router.push("/wallet");
    router.refresh();
  }

  return (
    <form onSubmit={submit} encType="multipart/form-data">
      <div className="field">
        <label htmlFor="txnRef">{t("qr.txnId")}</label>
        <input id="txnRef" name="txnRef" type="text" required minLength={4} maxLength={64} autoComplete="off" className="mono" />
      </div>
      <div className="field">
        <label htmlFor="receipt">{t("qr.receipt")}</label>
        <input id="receipt" name="receipt" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" />
        <span className="hint">PNG, JPG, WebP, PDF · ≤ 3 MB</span>
      </div>
      <div className="field">
        <label htmlFor="note">{t("qr.note")}</label>
        <input id="note" name="note" type="text" maxLength={300} />
      </div>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="upload" size={18} />} {t("qr.submit")}</button>
      <button className="btn btn-ghost btn-block mt" type="button" onClick={cancel}>{t("qr.cancel")}</button>
    </form>
  );
}
