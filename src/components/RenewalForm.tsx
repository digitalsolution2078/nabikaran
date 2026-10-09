"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { PRESET_OFFSET_DAYS, describeOffset, offsetFromParts } from "@/lib/scheduler";
import type { SchedulePreview } from "@/lib/core/dto";

const CATEGORIES = [
  ["bluebook", "Bluebook (vehicle)"], ["licence", "Driving licence"], ["passport", "Passport"], ["insurance", "Insurance"],
  ["warranty", "Warranty"], ["subscription", "Subscription"], ["other", "Other"],
] as const;

export interface RenewalFormValues {
  category: string; label: string; calendar: "AD" | "BS"; expiryDate: string; localTime: string; notes: string; familyMemberLabel: string; offsets: number[];
}

const WARNING_TEXT: Record<string, string> = {
  expiry_in_past: "This expiry date is already in the past.",
  some_offsets_in_past: "Some reminders would fall in the past and were skipped.",
  duplicate_offsets: "Duplicate reminder times were merged.",
  over_cap: "Only the first 10 reminders are kept.",
  beyond_two_year_horizon: "Reminders more than 2 years away are saved as planned and reserved later.",
  bs_date_needs_confirmation: "Please check the converted Gregorian date below is the one on your document.",
  insufficient_credits: "Not enough credits: reminders will be saved as Awaiting credits and scheduled automatically after you top up. Nothing is overdrawn.",
};

export function RenewalForm({ initial, renewalId }: { initial?: Partial<RenewalFormValues>; renewalId?: string }) {
  const router = useRouter();
  const [v, setV] = useState<RenewalFormValues>({
    category: "bluebook", label: "", calendar: "AD", expiryDate: "", localTime: "09:00", notes: "", familyMemberLabel: "",
    offsets: [30 * 1440, 7 * 1440, 1440, 0], ...initial,
  });
  const [custom, setCustom] = useState({ days: 0, hours: 0, minutes: 0 });
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  // One key per confirmed submission: a double-click or retry cannot create two renewals.
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof RenewalFormValues>(k: K, val: RenewalFormValues[K]) => { setV({ ...v, [k]: val }); setPreview(null); };
  const toggle = (m: number) => set("offsets", v.offsets.includes(m) ? v.offsets.filter((x) => x !== m) : [...v.offsets, m]);

  async function doPreview() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ preview: SchedulePreview }>("/api/renewals/preview", { method: "POST", json: { label: v.label, calendar: v.calendar, expiryDate: v.expiryDate, localTime: v.localTime, offsets: v.offsets } });
      setPreview(r.preview);
      setIdempotencyKey(crypto.randomUUID());
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true); setError(null);
    try {
      const body = { ...v, notes: v.notes || null, familyMemberLabel: v.familyMemberLabel || null, idempotencyKey };
      const r = renewalId
        ? await api<{ reminder: { id: string } }>(`/api/renewals/${renewalId}`, { method: "PATCH", json: body })
        : await api<{ reminder: { id: string } }>("/api/renewals", { method: "POST", json: body });
      router.push(`/renewals/${r.reminder.id}`);
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
          <p>Expiry: <strong>{preview.expiry.local}</strong> (Nepal time){preview.expiry.bs && <> · BS <strong>{preview.expiry.bs.display}</strong></>}</p>
          {preview.warnings.map((w) => <p key={w} className="notice">{WARNING_TEXT[w] ?? w}</p>)}
          <table>
            <thead><tr><th>Send at</th><th>Message</th><th>Credits</th></tr></thead>
            <tbody>
              {preview.lines.map((l) => (
                <tr key={l.offsetMinutes}>
                  <td>{l.due.local}<br /><span className="muted">{describeOffset(l.offsetMinutes)}{l.horizon === "beyond" ? " · planned (beyond 2 years)" : ""}</span></td>
                  <td><pre className="sms">{l.smsText}</pre><span className="muted">{l.encoding}, {l.segments} segment(s)</span></td>
                  <td>{l.credits}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Total projected: <strong>{preview.totalCredits} credits</strong> ({preview.creditsPerUnit} credits per SMS segment). Reserved now: {preview.reservedOnConfirmCredits}. Available: {preview.wallet.available}.{preview.shortfallCredits > 0 && <> Shortfall: {preview.shortfallCredits} — <a href="/wallet">top up</a>.</>}</p>
          <p className="muted" style={{ fontSize: 13 }}>Reserving is not charging. You are charged only when the provider accepts the SMS, for the actual segments sent; unused holds are released.</p>
          <button type="button" disabled={busy || preview.lines.length === 0} onClick={confirm}>{busy ? "Saving…" : renewalId ? "Save changes" : "Confirm & schedule"}</button>
        </div>
      )}
    </div>
  );
}
