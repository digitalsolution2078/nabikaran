"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePrefs } from "../Prefs";
import { Icon } from "../Icon";
import type { MessageKey } from "@/lib/i18n/dict";

const SUP_ERRORS = ["name_required", "invalid_phone", "invalid_email", "contact_required", "attachment_too_large", "invalid_attachment", "ticket_closed", "invalid_body"];

const CATS = ["payment", "reminder", "account", "pro", "other"] as const;

/** Open a support ticket. Visitors also give a name and a phone or email. */
export function SupportForm({ signedIn }: { signedIn: boolean }) {
  const { t } = usePrefs();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ref: string; id?: string; link: string | null } | null>(null);
  const [cat, setCat] = useState<(typeof CATS)[number]>("payment");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    form.set("category", cat);
    const f = form.get("attachment");
    if (f instanceof File && f.size > 3 * 1024 * 1024) {
      setError(t("sup.tooLarge"));
      setBusy(false);
      return;
    }
    const res = await fetch("/api/support/tickets", { method: "POST", body: form, credentials: "same-origin" });
    const data = (await res.json().catch(() => ({}))) as { ref?: string; id?: string; guestToken?: string | null; error?: string; code?: string };
    setBusy(false);
    if (!res.ok) {
      setError(data.code && SUP_ERRORS.includes(data.code) ? t(`sup.err.${data.code}` as MessageKey) : res.status === 429 ? t("sup.err.rate") : (data.error ?? t("common.error")));
      return;
    }
    const link = data.guestToken ? `${window.location.origin}/support/t/${data.guestToken}` : null;
    setDone({ ref: data.ref ?? "", id: data.id, link });
    if (signedIn) router.refresh();
  }

  if (done) {
    return (
      <div className="card support-done">
        <div className="done-icon"><Icon name="check" size={28} /></div>
        <h2>{t("sup.sentTitle", { ref: done.ref })}</h2>
        <p className="muted">{t("sup.sentText")}</p>
        {done.link && (
          <div className="alert warn">
            <Icon name="lock" />
            <span>
              <strong>{t("sup.saveLink")}</strong><br />
              <a href={done.link} className="mono small" style={{ overflowWrap: "anywhere" }}>{done.link}</a>
            </span>
          </div>
        )}
        <div className="row">
          {done.link ? <a className="btn btn-primary" href={done.link}>{t("sup.openTicket")}</a> : done.id && <Link className="btn btn-primary" href={`/support/${done.id}`}>{t("sup.openTicket")}</Link>}
          <button type="button" className="btn btn-secondary" onClick={() => setDone(null)}>{t("sup.another")}</button>
        </div>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit} encType="multipart/form-data">
      <h2>{t("sup.newTitle")}</h2>
      <fieldset className="field">
        <legend className="label">{t("sup.category")}</legend>
        <div className="chips">
          {CATS.map((c) => (
            <button type="button" key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}>{t(`sup.cat.${c}` as MessageKey)}</button>
          ))}
        </div>
      </fieldset>
      {!signedIn && (
        <div className="grid grid-3">
          <div className="field"><label htmlFor="s-name">{t("sup.name")}</label><input id="s-name" name="name" required minLength={2} maxLength={80} autoComplete="name" /></div>
          <div className="field"><label htmlFor="s-phone">{t("sup.phone")}</label><input id="s-phone" name="phone" type="tel" inputMode="tel" maxLength={20} autoComplete="tel" placeholder="98XXXXXXXX" /></div>
          <div className="field"><label htmlFor="s-email">{t("sup.email")}</label><input id="s-email" name="email" type="email" maxLength={160} autoComplete="email" /></div>
        </div>
      )}
      {!signedIn && <p className="hint" style={{ marginTop: -6 }}>{t("sup.contactHint")}</p>}
      <div className="field"><label htmlFor="s-subject">{t("sup.subject")}</label><input id="s-subject" name="subject" required minLength={3} maxLength={140} /></div>
      <div className="field">
        <label htmlFor="s-body">{t("sup.body")}</label>
        <textarea id="s-body" name="body" required minLength={5} maxLength={5000} rows={6} placeholder={cat === "payment" ? t("sup.bodyPaymentHint") : t("sup.bodyHint")} />
      </div>
      <div className="field">
        <label htmlFor="s-file">{t("sup.attach")}</label>
        <input id="s-file" name="attachment" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" />
        <span className="hint">{t("sup.attachHint")}</span>
      </div>
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hp" aria-hidden />
      {error && <div className="alert bad" role="alert">{error}</div>}
      <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="message" size={18} />} {t("sup.submit")}</button>
    </form>
  );
}
