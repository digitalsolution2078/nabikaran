import { adToBs, formatBs } from "../bs-date";
import { formatKathmandu, utcToKathmandu } from "../time";

/** Expiry/due instants in every form a client (web or AI) may need. */
export interface InstantDTO {
  utc: string;
  /** "YYYY-MM-DD HH:MM" in Asia/Kathmandu */
  local: string;
  /** Gregorian calendar date in Nepal time, YYYY-MM-DD */
  ad: string;
  /** Bikram Sambat, "YYYY-MM-DD" and human form; null when outside the supported range */
  bs: { date: string; display: string } | null;
}

export function instantDTO(d: Date): InstantDTO {
  const k = utcToKathmandu(d);
  const ad = `${k.year}-${String(k.month).padStart(2, "0")}-${String(k.day).padStart(2, "0")}`;
  let bs: InstantDTO["bs"] = null;
  try {
    const b = adToBs({ year: k.year, month: k.month, day: k.day });
    bs = { date: `${b.year}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`, display: formatBs(b, "ne") };
  } catch {
    bs = null;
  }
  return { utc: d.toISOString(), local: formatKathmandu(d), ad, bs };
}

export type JobStatus = "planned" | "awaiting_credits" | "scheduled" | "sending" | "submitted" | "delivered" | "failed" | "unknown" | "cancelled";

export interface ReminderJobDTO {
  id: string;
  offsetMinutes: number;
  due: InstantDTO;
  status: JobStatus;
  estimatedSegments: number;
  estimatedCredits: number;
  lastError: string | null;
}

export interface ReminderDTO {
  id: string;
  label: string;
  category: string;
  status: "active" | "paused" | "cancelled";
  cycleNo: number;
  expiry: InstantDTO;
  localTime: string;
  inputCalendar: "AD" | "BS";
  inputDate: string | null;
  notes: string | null;
  familyMemberLabel: string | null;
  jobs: ReminderJobDTO[];
  createdAt: string;
  updatedAt: string;
}

export type Warning =
  | "expiry_in_past"
  | "some_offsets_in_past"
  | "duplicate_offsets"
  | "over_cap"
  | "beyond_two_year_horizon"
  | "bs_date_needs_confirmation"
  | "insufficient_credits";

export interface SchedulePreviewLine {
  offsetMinutes: number;
  due: InstantDTO;
  horizon: "within" | "beyond";
  smsText: string;
  segments: number;
  encoding: string;
  credits: number;
}

export interface SchedulePreview {
  expiry: InstantDTO;
  lines: SchedulePreviewLine[];
  totalCredits: number;
  reservedOnConfirmCredits: number;
  creditsPerUnit: number;
  pricingVersion: number;
  wallet: { available: number; reserved: number; posted: number };
  sufficient: boolean;
  shortfallCredits: number;
  warnings: Warning[];
  dropped: { past: number; duplicate: number; overCap: number };
}
