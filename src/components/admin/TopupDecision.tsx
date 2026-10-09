"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

export function TopupDecision({ id, reference, amount }: { id: string; reference: string; amount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState<null | "approve" | "reject">(null);
  const [bankRef, setBankRef] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (open === "approve") {
        if (!confirm(`Approve ${reference} and add ${amount} credits?\n\nConfirm you found NPR ${amount} in the bank/merchant statement with reference ${bankRef}.`)) return;
        await api(`/api/admin/topups/${id}`, { method: "POST", json: { action: "approve", bankRef, notes: notes || null, confirm: true } });
      } else {
        if (!confirm(`Reject ${reference}? No credits will be added.`)) return;
        await api(`/api/admin/topups/${id}`, { method: "POST", json: { action: "reject", reason: notes, confirm: true } });
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="row mt">
        <button className="btn btn-primary btn-sm" onClick={() => setOpen("approve")}>Approve…</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setOpen("reject")}>Reject…</button>
      </div>
    );
  }
  return (
    <div className="mt" style={{ minWidth: 240 }}>
      {open === "approve" && (
        <div className="field">
          <label htmlFor={`bank-${id}`}>Statement transaction reference</label>
          <input id={`bank-${id}`} type="text" className="mono" value={bankRef} onChange={(e) => setBankRef(e.target.value)} placeholder="from EBL / Fonepay statement" />
        </div>
      )}
      <div className="field">
        <label htmlFor={`notes-${id}`}>{open === "approve" ? "Verification notes (optional)" : "Rejection reason (shown to customer)"}</label>
        <input id={`notes-${id}`} type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {err && <p className="field-error" role="alert">{err}</p>}
      <div className="row">
        <button className={`btn btn-sm ${open === "approve" ? "btn-primary" : "btn-danger"}`} disabled={busy || (open === "approve" ? bankRef.trim().length < 4 : notes.trim().length < 3)} onClick={submit}>{open === "approve" ? "Confirm approval" : "Confirm rejection"}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>Cancel</button>
      </div>
    </div>
  );
}

export function AdjustmentApprove({ id, credits }: { id: string; credits: number }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn btn-secondary btn-sm"
        onClick={async () => {
          if (!confirm(`Approve this adjustment of ${credits > 0 ? "+" : ""}${credits} credits?`)) return;
          try {
            await api("/api/admin/adjustments", { method: "POST", json: { action: "approve", requestId: id } });
            router.refresh();
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >Approve</button>
      {err && <span className="field-error"> {err}</span>}
    </>
  );
}
