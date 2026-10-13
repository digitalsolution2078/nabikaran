"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

const MAX_BYTES = 3 * 1024 * 1024;

/** Phone photos are often 4–8 MB: shrink images in the browser so they fit the 3 MB limit. */
async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size <= 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

export function QrSubmit({ requestId }: { requestId: string }) {
  const router = useRouter();
  const { t } = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const f = form.get("receipt");
    if (f instanceof File && f.size > 0) {
      const small = await shrinkImage(f);
      if (small.size > MAX_BYTES) {
        setError(t("qr.tooLarge", { mb: (small.size / 1024 / 1024).toFixed(1) }));
        setBusy(false);
        return;
      }
      form.set("receipt", small);
    }
    const res = await fetch(`/api/topups/manual/${requestId}`, { method: "POST", body: form, credentials: "same-origin" });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(data.error === "receipt_too_large" ? t("qr.tooLarge", { mb: "3+" }) : (data.error ?? t("common.error")));
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
        <input id="receipt" name="receipt" type="file" accept="image/png,image/jpeg,image/webp,application/pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            setError(null);
            setFileNote(f && f.type === "application/pdf" && f.size > MAX_BYTES ? t("qr.tooLarge", { mb: (f.size / 1024 / 1024).toFixed(1) }) : null);
          }} />
        <span className="hint">{t("qr.receiptHint")}</span>
        {fileNote && <span className="field-error">{fileNote}</span>}
      </div>
      <div className="field">
        <label htmlFor="note">{t("qr.note")}</label>
        <input id="note" name="note" type="text" maxLength={300} />
      </div>
      <div className="alert info"><Icon name="clock" /> <span>{t("qr.verifyTime")}</span></div>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="upload" size={18} />} {t("qr.submit")}</button>
      <button className="btn btn-ghost btn-block mt" type="button" onClick={cancel}>{t("qr.cancel")}</button>
    </form>
  );
}
