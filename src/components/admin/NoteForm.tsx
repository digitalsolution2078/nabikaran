"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

export function NoteForm({ userId }: { userId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/admin/users/${userId}/notes`, { method: "POST", json: { body } });
      setBody("");
      setMsg(null);
      router.refresh();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }
  return (
    <form onSubmit={save} className="stack" style={{ gap: 8 }}>
      <label htmlFor="note" className="sr-only">Support note</label>
      <textarea id="note" rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="e.g. Called about failed SMS on 12 Kartik; advised to top up." />
      <div className="row"><button className="btn btn-secondary btn-sm" disabled={body.trim().length < 2}>Add note</button>{msg && <span className="small text-bad">{msg}</span>}</div>
      <p className="hint mb-0">Notes are permanent (cannot be edited or deleted) and visible to staff only. Do not paste OTPs, passwords or payment card data.</p>
    </form>
  );
}
