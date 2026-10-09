import { describe, expect, it } from "vitest";
import { DICTS, translate } from "@/lib/i18n/dict";
import { clockText, formatDate, formatTime, nepaliDigits, daysUntil, otherCalendar, offsetLabel } from "@/lib/i18n/format";
import { decodePrefs, encodePrefs } from "@/lib/i18n/prefs";
import { kathmanduToUtc } from "@/lib/time";

describe("dictionaries", () => {
  it("Nepali defines every English key, non-empty, with the same placeholders", () => {
    const en = Object.keys(DICTS.en).sort();
    expect(Object.keys(DICTS.ne).sort()).toEqual(en);
    for (const k of en) {
      const a = DICTS.en[k as keyof typeof DICTS.en];
      const b = DICTS.ne[k as keyof typeof DICTS.ne];
      expect(b.trim().length, k).toBeGreaterThan(0);
      expect((b.match(/\{\w+\}/g) ?? []).sort(), k).toEqual((a.match(/\{\w+\}/g) ?? []).sort());
    }
  });
  it("interpolates variables", () => {
    expect(translate("en", "dash.daysLeft", { n: 7 })).toBe("7 days left");
    expect(translate("ne", "dash.daysLeft", { n: "७" })).toBe("७ दिन बाँकी");
  });
});

describe("preferences cookie", () => {
  it("round-trips and rejects junk", () => {
    expect(decodePrefs(encodePrefs({ lang: "en", date: "AD" }))).toEqual({ lang: "en", date: "AD" });
    expect(decodePrefs("ne.BS")).toEqual({ lang: "ne", date: "BS" });
    for (const bad of [null, "", "fr.BS", "ne.XX", "ne", "<script>"]) expect(decodePrefs(bad)).toBeNull();
  });
});

describe("Nepal-time date display", () => {
  // 2026-10-09 19:40 NPT == 13:55 UTC; BS 2083-06-23 (Asoj 23), Friday
  const instant = new Date("2026-10-09T13:55:00Z");
  it("AD and BS in both languages", () => {
    expect(formatDate(instant, { lang: "en", date: "AD" })).toBe("9 October 2026");
    expect(formatDate(instant, { lang: "en", date: "BS" })).toBe("23 Aswin 2083");
    expect(formatDate(instant, { lang: "ne", date: "BS" })).toBe("२०८३ असोज २३");
    expect(formatDate(instant, { lang: "ne", date: "AD" })).toBe("२०२६ अक्टोबर ९");
    expect(otherCalendar(instant, { lang: "en", date: "BS" })).toBe("9 October 2026");
  });
  it("clock shows weekday, date and NPT time", () => {
    expect(clockText(instant, { lang: "en", date: "AD" })).toEqual({ day: "Friday", date: "9 October 2026", time: "7:40 PM NPT" });
    const ne = clockText(instant, { lang: "ne", date: "BS" });
    expect(ne.day).toBe("शुक्रबार");
    expect(ne.date).toBe("२०८३ असोज २३");
    expect(formatTime(instant, { lang: "ne", date: "BS" })).toBe("७:४० बेलुका");
  });
  it("date-only expiry never shifts across the day boundary in NPT", () => {
    // 2026-10-09 stored as 09:00 NPT; just after midnight NPT and just before are still the same calendar date
    for (const t of ["00:00", "00:30", "05:44", "05:45", "23:59"]) {
      const u = kathmanduToUtc({ year: 2026, month: 10, day: 9 }, t);
      expect(formatDate(u, { lang: "en", date: "AD" }), t).toBe("9 October 2026");
    }
  });
  it("days until and digits", () => {
    const now = new Date("2026-10-09T18:00:00Z"); // 23:45 NPT on Oct 9
    expect(daysUntil(kathmanduToUtc({ year: 2026, month: 10, day: 10 }), now)).toBe(1);
    expect(nepaliDigits("2083-06-23")).toBe("२०८३-०६-२३");
  });
});

describe("offsetLabel", () => {
  it("localizes reminder offsets", () => {
    expect(offsetLabel(0, "en")).toBe("on expiry");
    expect(offsetLabel(30 * 1440, "en")).toBe("30 days before");
    expect(offsetLabel(1440, "en")).toBe("1 day before");
    expect(offsetLabel(30 * 1440, "ne")).toBe("३० दिन अगाडि");
    expect(offsetLabel(0, "ne")).toBe("म्याद सकिने दिन");
    expect(offsetLabel(1440 + 120, "ne")).toBe("१ दिन २ घण्टा अगाडि");
  });
});
