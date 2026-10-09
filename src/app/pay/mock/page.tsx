"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/components/api";

function MockCheckout() {
  const pidx = useSearchParams().get("pidx") ?? "";
  const [busy, setBusy] = useState(false);
  async function settle(status: "completed" | "canceled" | "pending", amountPaisa?: number) {
    setBusy(true);
    const r = await api<{ next: string }>("/api/pay/mock", { method: "POST", json: { pidx, status, amountPaisa } });
    window.location.href = r.next;
  }
  return (
    <div className="card">
      <h1>Mock checkout (development)</h1>
      <p className="muted">Reference: {pidx}</p>
      <div className="row">
        <button disabled={busy} onClick={() => settle("completed")}>Pay (Completed)</button>
        <button disabled={busy} className="secondary" onClick={() => settle("canceled")}>Cancel</button>
        <button disabled={busy} className="secondary" onClick={() => settle("pending")}>Leave pending</button>
        <button disabled={busy} className="danger" onClick={() => settle("completed", 1)}>Tampered amount</button>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><MockCheckout /></Suspense>;
}
