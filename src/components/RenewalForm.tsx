"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { PRESET_OFFSET_DAYS, describeOffset, offsetFromParts } from "@/lib/scheduler";

const CATEGORIES = [
  ["bluebook", "Bluebook (vehicle)"], ["licence", "Driving licence"], ["passport", "Passport"], ["insurance", "Insurance"],
  ["warranty", "Warranty"], ["subscription", "Subscription"], ["other", "Other"],
] as const;

interface PreviewLine { offsetMinutes: number; dueAtUtc: string; horizon: string; body: string; segments: number; encoding: string; credits: number }
interface PreviewResp {
  preview: { expiryAtUtc: string; lines: PreviewLine[]; totalCredits: number; reservedNowCredits: number; creditsPerUnit: number; dropped: { past: number; duplicate: number; overCap: number } };
  wallet: { available: number };
  sufficient: boolean;
}

export interface RenewalFormValues {
  category: string; label: string; calendar: "AD" | "BS"; expiryDate: string; localTime: string; notes: string; familyMemberLabel: string; offsets: number[];
}

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" });

export function RenewalForm({ initial, renewalId }: { initial?: Partial<RenewalFormValues>; renewalId?: string }) {
  const router = useRouter();
  const [v, setV] = useState<RenewalFormValues>({
    category: "bluebook", label: "", calendar: "AD", expiryDate: "", localTime: "09:00", notes: "", familyMemberLabel: "",
    offsets: [30 * 1440, 7 * 1440, 1440, 0], ...initial,
  });
  const [custom, setCustom] = useState({ days: 0, hours: 0, minutes: 0 });
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof RenewalFormValues>(k: K, val: RenewalFormValues[K]) => { setV({ ...v, [k]: val }); setPreview(null); };
  const toggle = (m: number) => set("offsets", v.offsets.includes(m) ? v.offsets.filter((x) => x !== m) : [...v.offsets, m]);

  async function doPreview() {
    setBusy(true); setError(null);
    try {
      setPreview(await api<PreviewResp>("/api/renewals/preview", { method: "POST", json: { label: v.label, calendar: v.calendar, expiryDate: v.expiryDate, localTime: v.localTime, offsets: v.offsets } }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true); setError(null);
    try {
      const body = { ...v, notes: v.notes || null, familyMemberLabel: v.familyMemberLabel || null };
      const r = renewalId
        ? await api<{ renewal: { id: string } }>(`/api/renewals/${renewalId}`, { method: "PATCH", json: body })
        : await api<{ renewal: { id: string } }>("/api/renewals", { method: "POST", json: body });
      router.push(`/renewals/${r.renewal.id}`);
      router.refresh();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div>
      <div className="card">
        <label>Category</label>
        <select value={v.category} onChange={(e) => set("category", e.target.value)}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <label>Label (appears in the SMS)</label>
        <input value={v.label} maxLength={80} onChange={(e) => set("label", e.target.value)} placeholder="e.g. Ba 2 Pa 1234 Bluebook" required />
        <label>Calendar</label>
        <div className="chips">
          <button type="button" className={`chip ${v.calendar === "AD" ? "on" : ""}`} onClick={() => set("calendar", "AD")}>Gregorian (AD)</button>
          <button type="button" className={`chip ${v.calendar === "BS" ? "on" : ""}`} onClick={() => set("calendar", "BS")}>Bikram Sambat (BS)</button>
        </div>
        <label>Expiry date {v.calendar === "BS" ? "(BS, YYYY-MM-DD e.g. 2082-03-15)" : ""}</label>
        {v.calendar === "AD"
          ? <input type="date" value={v.expiryDate} onChange={(e) => set("expiryDate", e.target.value)} required />
          : <input inputMode="numeric" placeholder="2082-03-15" value={v.expiryDate} onChange={(e) => set("expiryDate", e.target.value)} required />}
        <label>Expiry time (Nepal time) — defaults to 09:00; this is your choice, not an official timestamp</label>
        <input type="time" value={v.localTime} onChange={(e) => set("localTime", e.target.value)} />
        <label>Family member (optional label; SMS still goes to your phone)</label>
        <input value={v.familyMemberLabel} maxLength={60} onChange={(e) => set("familyMemberLabel", e.target.value)} />
        <label>Notes (private)</label>
        <textarea value={v.notes} maxLength={500} rows={2} onChange={(e) => set("notes", e.target.value)} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Remind me</h2>
        <div className="chips">
          {PRESET_OFFSET_DAYS.map((d) => {
            const m = d * 1440;
            return <button type="button" key={d} className={`chip ${v.offsets.includes(m) ? "on" : ""}`} onClick={() => toggle(m)}>{d === 0 ? "On the day" : `${d} days before`}</button>;
          })}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <input type="number" min={0} style={{ width: 90 }} value={custom.days} onChange={(e) => setCustom({ ...custom, days: +e.target.value })} aria-label="days" /> d
          <input type="number" min={0} max={23} style={{ width: 80 }} value={custom.hours} onChange={(e) => setCustom({ ...custom, hours: +e.target.value })} aria-label="hours" /> h
          <input type="number" min={0} max={59} style={{ width: 80 }} value={custom.minutes} onChange={(e) => setCustom({ ...custom, minutes: +e.target.value })} aria-label="minutes" /> m
          <button type="button" className="secondary" onClick={() => toggle(offsetFromParts(custom.days, custom.hours, custom.minutes))}>Add custom</button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Selected: {v.offsets.length ? v.offsets.slice().sort((a, b) => b - a).map(describeOffset).join(", ") : "none"} · max 10 reminders per renewal</p>
        {error && <div className="error">{error}</div>}
        <button type="button" disabled={busy || !v.label || !v.expiryDate || v.offsets.length === 0} onClick={doPreview}>{busy ? "…" : "Preview cost"}</button>
      </div>

      {preview && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Confirm</h2>
          <p>Expiry: <strong>{fmt(preview.preview.expiryAtUtc)}</strong> (Nepal time)</p>
          <table>
            <thead><tr><th>Send at</th><th>Message</th><th>Credits</th></tr></thead>
            <tbody>
              {preview.preview.lines.map((l) => (
                <tr key={l.offsetMinutes}>
                  <td>{fmt(l.dueAtUtc)}<br /><span className="muted">{describeOffset(l.offsetMinutes)}{l.horizon === "beyond" ? " · planned (beyond 2 years)" : ""}</span></td>
                  <td><pre className="sms">{l.body}</pre><span className="muted">{l.encoding}, {l.segments} segment(s)</span></td>
                  <td>{l.credits}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Total projected: <strong>{preview.preview.totalCredits} credits</strong> ({preview.preview.creditsPerUnit} credits per SMS segment). Reserved now: {preview.preview.reservedNowCredits}. Available: {preview.wallet.available}.</p>
          {(preview.preview.dropped.past > 0 || preview.preview.dropped.overCap > 0) && (
            <p className="notice">{preview.preview.dropped.past} reminder(s) are already in the past and were skipped{preview.preview.dropped.overCap ? `; ${preview.preview.dropped.overCap} over the 10-reminder cap` : ""}.</p>
          )}
          {!preview.sufficient && <p className="notice">Not enough credits: reminders will be saved as <em>Awaiting credits</em> and scheduled automatically after you <a href="/wallet">top up</a>. Nothing is overdrawn.</p>}
          <p className="muted" style={{ fontSize: 13 }}>Reserving is not charging. You are charged only when the provider accepts the SMS, for the actual segments sent; unused holds are released.</p>
          <button type="button" disabled={busy} onClick={confirm}>{busy ? "Saving…" : renewalId ? "Save changes" : "Confirm & schedule"}</button>
        </div>
      )}
    </div>
  );
}
