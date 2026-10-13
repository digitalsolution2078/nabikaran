"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePrefs } from "../Prefs";
import { Icon } from "../Icon";
import { formatDateTime } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/dict";

const SUP_ERRORS = ["name_required", "invalid_phone", "invalid_email", "contact_required", "attachment_too_large", "invalid_attachment", "ticket_closed", "invalid_body"];

export interface ThreadMessage {
  id: string;
  author: "customer" | "staff" | "system";
  authorName: string | null;
  body: string;
  internal: boolean;
  createdAt: string;
  attachment: { id: string; contentType: string; size: number } | null;
}

/** Customer view of a ticket: the conversation and a reply box. `token` for visitors (private link). */
export function TicketThread({ messages, status, replyUrl, token }: { messages: ThreadMessage[]; status: string; replyUrl: string; token?: string }) {
  const { t, prefs } = usePrefs();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    setBusy(true);
    setError(null);
    const res = await fetch(replyUrl, { method: "POST", body: new FormData(formEl), credentials: "same-origin" });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    setBusy(false);
    if (!res.ok) {
      setError(data.code && SUP_ERRORS.includes(data.code) ? t(`sup.err.${data.code}` as MessageKey) : res.status === 429 ? t("sup.err.rate") : (data.error ?? t("common.error")));
      return;
    }
    formEl.reset();
    router.refresh();
  }

  return (
    <div className="stack">
      <ol className="thread">
        {messages.filter((m) => m.author !== "system").map((m) => (
          <li key={m.id} className={`bubble ${m.author === "staff" ? "from-staff" : "from-me"}`}>
            <div className="bubble-meta">
              <strong>{m.author === "staff" ? (m.authorName ?? t("sup.team")) : t("sup.you")}</strong>
              <span>{formatDateTime(m.createdAt, prefs)}</span>
            </div>
            <div className="bubble-body">{m.body}</div>
            {m.attachment && (
              <a className="bubble-file" href={`/api/support/attachments/${m.attachment.id}${token ? `?t=${token}` : ""}`} target="_blank" rel="noopener">
                <Icon name="file" size={14} /> {t("sup.file")} · {Math.ceil(m.attachment.size / 1024)} KB
              </a>
            )}
          </li>
        ))}
      </ol>
      {status === "closed" ? (
        <div className="alert info"><Icon name="info" /> <span>{t("sup.closedNote")}</span></div>
      ) : (
        <form className="card" onSubmit={send} encType="multipart/form-data">
          <div className="field">
            <label htmlFor="r-body">{t("sup.reply")}</label>
            <textarea id="r-body" name="body" required maxLength={5000} rows={4} />
          </div>
          <div className="field">
            <label htmlFor="r-file">{t("sup.attach")}</label>
            <input id="r-file" name="attachment" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" />
          </div>
          {error && <div className="alert bad" role="alert">{error}</div>}
          <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="message" size={16} />} {t("sup.send")}</button>
        </form>
      )}
    </div>
  );
}

export function TicketStatusBadge({ status }: { status: string }) {
  const { t } = usePrefs();
  const tone = status === "open" ? "info" : status === "waiting_customer" ? "warn" : status === "resolved" ? "ok" : "";
  return <span className={`badge ${tone}`}>{t(`sup.status.${status}` as MessageKey)}</span>;
}
