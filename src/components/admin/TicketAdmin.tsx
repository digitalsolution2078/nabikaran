"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "../Icon";

export interface AdminThreadMessage {
  id: string;
  author: "customer" | "staff" | "system";
  authorName: string | null;
  body: string;
  internal: boolean;
  createdAt: string;
  attachment: { id: string; contentType: string; size: number } | null;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" });

/** Staff view of one ticket: thread (with internal notes), reply / note box and status controls. */
export function TicketAdmin({ ticketId, status, priority, assignedToMe, messages, customerName }: { ticketId: string; status: string; priority: string; assignedToMe: boolean; messages: AdminThreadMessage[]; customerName: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/support/${ticketId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    setBusy(false);
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Failed");
    else router.refresh();
  }

  async function send(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    form.set("action", mode);
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/support/${ticketId}`, { method: "POST", body: form, credentials: "same-origin" });
    setBusy(false);
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Failed");
      return;
    }
    formEl.reset();
    router.refresh();
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="small muted">Status:</span>
        {(["open", "waiting_customer", "resolved", "closed"] as const).map((s) => (
          <button key={s} type="button" className={`btn btn-sm ${status === s ? "btn-primary" : "btn-secondary"}`} disabled={busy || status === s} onClick={() => act({ action: "status", status: s })}>{s.replace("_", " ")}</button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act({ action: "priority", priority: priority === "high" ? "normal" : "high" })}>{priority === "high" ? "Set normal priority" : "Mark high priority"}</button>
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act({ action: "assign", toMe: !assignedToMe })}>{assignedToMe ? "Unassign me" : "Assign to me"}</button>
      </div>

      <ol className="thread">
        {messages.map((m) => (
          <li key={m.id} className={`bubble ${m.author === "customer" ? "from-me" : "from-staff"} ${m.internal ? "internal" : ""} ${m.author === "system" ? "system" : ""}`}>
            <div className="bubble-meta">
              <strong>{m.author === "customer" ? customerName : m.author === "system" ? "System" : (m.authorName ?? "Staff")}{m.internal && m.author !== "system" ? " · internal note" : ""}</strong>
              <span>{when(m.createdAt)}</span>
            </div>
            <div className="bubble-body">{m.body}</div>
            {m.attachment && <a className="bubble-file" href={`/api/support/attachments/${m.attachment.id}`} target="_blank" rel="noopener"><Icon name="file" size={14} /> {m.attachment.contentType} · {Math.ceil(m.attachment.size / 1024)} KB</a>}
          </li>
        ))}
      </ol>

      <form className="card" onSubmit={send} encType="multipart/form-data">
        <div className="segmented" role="group" aria-label="Message type">
          <button type="button" aria-pressed={mode === "reply"} onClick={() => setMode("reply")}>Reply to customer</button>
          <button type="button" aria-pressed={mode === "note"} onClick={() => setMode("note")}>Internal note</button>
        </div>
        <div className="field mt">
          <textarea name="body" required maxLength={5000} rows={5} placeholder={mode === "reply" ? "The customer sees this and gets a notification." : "Only staff see this."} aria-label="Message" />
        </div>
        <div className="row">
          <input name="attachment" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" aria-label="Attachment" />
          {mode === "reply" && (
            <select name="status" defaultValue="waiting_customer" aria-label="Status after reply" style={{ width: "auto" }}>
              <option value="waiting_customer">then: waiting for customer</option>
              <option value="resolved">then: resolved</option>
              <option value="open">then: keep open</option>
            </select>
          )}
          <button className="btn btn-primary" disabled={busy} style={{ marginLeft: "auto" }}>{busy ? <span className="spinner" /> : <Icon name="message" size={16} />} {mode === "reply" ? "Send reply" : "Save note"}</button>
        </div>
        {error && <div className="alert bad mt" role="alert">{error}</div>}
      </form>
    </div>
  );
}
