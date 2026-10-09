"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export function RenewalActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: "pause" | "resume" | "cancel" | "delete") {
    if ((action === "cancel" || action === "delete") && !confirm("Unsent reminders will be cancelled and their credit holds released. Continue?")) return;
    setBusy(true); setError(null);
    try {
      if (action === "delete") { await api(`/api/renewals/${id}`, { method: "DELETE" }); router.push("/renewals"); }
      else await api(`/api/renewals/${id}`, { method: "PATCH", json: { action } });
      router.refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="row">
      {status === "active" && <button className="secondary" disabled={busy} onClick={() => act("pause")}>Pause</button>}
      {status === "paused" && <button disabled={busy} onClick={() => act("resume")}>Resume</button>}
      {status !== "cancelled" && <button className="secondary" disabled={busy} onClick={() => act("cancel")}>Cancel reminders</button>}
      <button className="danger" disabled={busy} onClick={() => act("delete")}>Delete</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
