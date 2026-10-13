"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import { bonusFor, type BonusTier } from "@/lib/bonus";

/** Admin: top-up bonus tiers (minimum NPR → bonus %). Applies to new top-ups only. */
export function BonusTiersEditor({ tiers, canEdit }: { tiers: BonusTier[]; canEdit: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState(tiers.map((t) => ({ minNpr: String(t.minNpr), percent: String(t.percent) })));
  const [msg, setMsg] = useState<string | null>(null);
  const parsed = rows.map((r) => ({ minNpr: Number(r.minNpr), percent: Number(r.percent) })).filter((r) => r.minNpr > 0 && r.percent > 0);

  async function save() {
    setMsg(null);
    try {
      await api("/api/admin/bonus-tiers", { method: "POST", json: { tiers: parsed } });
      setMsg("Saved. New top-ups use these tiers.");
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Top-up from (NPR)</th><th>Bonus %</th><th className="num">Example</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const min = Number(r.minNpr) || 0;
              return (
                <tr key={i}>
                  <td>{canEdit ? <input type="number" min={1} step={1} value={r.minNpr} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, minNpr: e.target.value } : x)))} aria-label="Minimum NPR" style={{ width: 120 }} /> : r.minNpr}</td>
                  <td>{canEdit ? <input type="number" min={0.01} max={50} step={0.5} value={r.percent} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} aria-label="Bonus percent" style={{ width: 90 }} /> : `${r.percent}%`}</td>
                  <td className="num small">{min > 0 ? `NPR ${min.toLocaleString("en-IN")} → ${(min + bonusFor(min, parsed)).toLocaleString("en-IN")} credits` : "—"}</td>
                  {canEdit && <td><button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></td>}
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={4} className="muted">No bonus: customers get exactly 1 credit per rupee.</td></tr>}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="row">
          <button type="button" className="btn btn-secondary btn-sm" disabled={rows.length >= 8} onClick={() => setRows([...rows, { minNpr: "", percent: "" }])}>Add tier</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save}>Save tiers</button>
          {msg && <span className="small" role="status">{msg}</span>}
        </div>
      )}
      <p className="hint mb-0">Applies to wallet top-ups by QR, payment gateways and the counter — not to gift cards or coupons. The bonus is fixed when the customer starts the top-up and is posted as a separate “bonus” line in the ledger.</p>
    </div>
  );
}
