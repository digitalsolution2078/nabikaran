import { describe, expect, it } from "vitest";
import { normalizeNepalPhone, redactPhone } from "@/lib/phone";
import { kathmanduToUtc, utcToKathmandu, parseIsoDate, formatKathmandu } from "@/lib/time";
import { adToBs, bsToAd, isValidBsDate, parseBsInput, bsDaysInMonth } from "@/lib/bs-date";
import { estimateSegments } from "@/lib/sms/segments";
import { renderReminder, sanitizeLabel } from "@/lib/sms/templates";
import { planReminders, MAX_REMINDERS_PER_CYCLE, retryDelayMs } from "@/lib/scheduler";
import { mapKhaltiStatus } from "@/lib/payments/khalti";

describe("phone normalization", () => {
  it("accepts common Nepal formats", () => {
    for (const v of ["9841234567", "09841234567", "+977 984-1234567", "977-9841234567", "009779841234567", "+9779841234567"]) {
      expect(normalizeNepalPhone(v)).toBe("+9779841234567");
    }
    expect(normalizeNepalPhone("9612345678")).toBe("+9779612345678");
  });
  it("rejects landlines, short numbers and foreign numbers", () => {
    for (const v of ["014412345", "984123456", "98412345678", "+919841234567", "", "abc", "9541234567"]) {
      expect(normalizeNepalPhone(v)).toBeNull();
    }
  });
  it("redacts for logs", () => {
    expect(redactPhone("+9779841234567")).toBe("+9779841****67");
  });
});

describe("Kathmandu time (UTC+05:45, no DST)", () => {
  it("date-only expiry defaults to 09:00 NPT = 03:15 UTC", () => {
    const d = kathmanduToUtc({ year: 2027, month: 3, day: 1 });
    expect(d.toISOString()).toBe("2027-03-01T03:15:00.000Z");
  });
  it("round-trips including minute offsets", () => {
    const d = kathmanduToUtc({ year: 2026, month: 12, day: 31 }, "23:50");
    expect(d.toISOString()).toBe("2026-12-31T18:05:00.000Z");
    expect(utcToKathmandu(d)).toMatchObject({ year: 2026, month: 12, day: 31, hour: 23, minute: 50 });
    expect(formatKathmandu(d)).toBe("2026-12-31 23:50");
  });
  it("rejects impossible calendar dates", () => {
    expect(parseIsoDate("2027-02-29")).toBeNull();
    expect(parseIsoDate("2028-02-29")).not.toBeNull();
    expect(parseIsoDate("2027-13-01")).toBeNull();
  });
});

describe("Bikram Sambat conversion", () => {
  it("converts known anchors", () => {
    expect(bsToAd({ year: 2081, month: 1, day: 1 })).toEqual({ year: 2024, month: 4, day: 13 });
    expect(adToBs({ year: 2024, month: 4, day: 13 })).toEqual({ year: 2081, month: 1, day: 1 });
  });
  it("round-trips across a year", () => {
    for (let m = 1; m <= 12; m++) {
      const bs = { year: 2082, month: m, day: bsDaysInMonth(2082, m)! };
      expect(adToBs(bsToAd(bs))).toEqual(bs);
    }
  });
  it("rejects out-of-range days instead of rolling over (library would silently roll)", () => {
    expect(isValidBsDate({ year: 2081, month: 1, day: 33 })).toBe(false);
    expect(() => bsToAd({ year: 2081, month: 1, day: 33 })).toThrow();
    expect(() => bsToAd({ year: 2095, month: 1, day: 1 })).toThrow();
    expect(parseBsInput("2081-01-31")).toEqual({ year: 2081, month: 1, day: 31 }); // Baisakh 2081 has 31 days
    expect(parseBsInput("2081-01-32")).toBeNull();
  });
});

describe("SMS segments", () => {
  it("counts GSM-7 and extension chars", () => {
    expect(estimateSegments("Hello")).toMatchObject({ encoding: "GSM-7", segments: 1 });
    expect(estimateSegments("a".repeat(160))).toMatchObject({ segments: 1 });
    expect(estimateSegments("a".repeat(161))).toMatchObject({ segments: 2 });
    expect(estimateSegments("a".repeat(306))).toMatchObject({ segments: 2 });
    expect(estimateSegments("a".repeat(307))).toMatchObject({ segments: 3 });
    expect(estimateSegments("{".repeat(80) + "a")).toMatchObject({ length: 161, segments: 2 });
  });
  it("Devanagari forces UCS-2: 70 single, 67 per part", () => {
    expect(estimateSegments("नमस्ते")).toMatchObject({ encoding: "UCS-2", segments: 1 });
    expect(estimateSegments("न".repeat(70))).toMatchObject({ segments: 1 });
    expect(estimateSegments("न".repeat(71))).toMatchObject({ segments: 2 });
    expect(estimateSegments("न".repeat(134))).toMatchObject({ segments: 2 });
    expect(estimateSegments("न".repeat(135))).toMatchObject({ segments: 3 });
  });
});

describe("templates", () => {
  const expiry = new Date("2027-03-01T03:15:00Z");
  it("renders Nepali default with day count and date", () => {
    const r = renderReminder({ label: "Bluebook", expiryAtUtc: expiry, dueAtUtc: new Date(expiry.getTime() - 7 * 86_400_000) });
    expect(r.body).toContain("Bluebook");
    expect(r.body).toContain("7 दिनमा");
    expect(r.body).toContain("2027-03-01");
    expect(r.estimate.encoding).toBe("UCS-2");
    expect(r.estimate.segments).toBeGreaterThanOrEqual(1);
  });
  it("uses the 'today' template at offset 0", () => {
    const r = renderReminder({ label: "Licence", expiryAtUtc: expiry, dueAtUtc: expiry, locale: "en-NP" });
    expect(r.templateCategory).toBe("today");
    expect(r.body).toContain("expires today");
  });
  it("caps and sanitizes labels so cost cannot be inflated unboundedly", () => {
    expect(sanitizeLabel("x".repeat(200)).length).toBe(40);
    expect(sanitizeLabel("a\u0000b\n\nc")).toBe("a b c");
  });
});

describe("scheduler", () => {
  const now = new Date("2026-10-09T00:00:00Z");
  const expiry = new Date("2026-11-09T03:15:00Z"); // 31 days out
  it("generates due dates, drops past and duplicates, caps at 10", () => {
    const plan = planReminders(expiry, [
      { offsetMinutes: 30 * 1440 }, { offsetMinutes: 7 * 1440 }, { offsetMinutes: 7 * 1440 }, { offsetMinutes: 0 },
      { offsetMinutes: 60 * 1440 }, { offsetMinutes: 45 * 1440 }, { offsetMinutes: 90, enabled: false },
    ], now);
    expect(plan.candidates.map((c) => c.offsetMinutes)).toEqual([30 * 1440, 7 * 1440, 0]);
    expect(plan.droppedPast).toBe(2);
    expect(plan.droppedDuplicate).toBe(1);
    expect(plan.candidates[0].dueAtUtc.toISOString()).toBe("2026-10-10T03:15:00.000Z");
  });
  it("caps to MAX per cycle and flags far-future as beyond horizon", () => {
    const far = new Date("2030-01-01T03:15:00Z");
    const rules = Array.from({ length: 15 }, (_, i) => ({ offsetMinutes: i * 1440 }));
    const plan = planReminders(far, rules, now);
    expect(plan.candidates).toHaveLength(MAX_REMINDERS_PER_CYCLE);
    expect(plan.droppedOverCap).toBe(5);
    expect(plan.candidates.every((c) => c.horizon === "beyond")).toBe(true);
  });
  it("retry backoff is capped exponential", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([1, 2, 4, 8, 16, 16].map((m) => m * 60_000));
  });
});

describe("khalti status mapping", () => {
  it("only Completed maps to completed", () => {
    expect(mapKhaltiStatus("Completed")).toBe("completed");
    expect(mapKhaltiStatus("Pending")).toBe("pending");
    expect(mapKhaltiStatus("Initiated")).toBe("initiated");
    expect(mapKhaltiStatus("User canceled")).toBe("canceled");
    expect(mapKhaltiStatus("Completed", true)).toBe("refunded");
    expect(mapKhaltiStatus(undefined)).toBe("unknown");
  });
});
