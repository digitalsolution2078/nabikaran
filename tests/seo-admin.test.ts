import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser } from "./helpers/db";
import type { Db } from "@/lib/db";
import { listSeoPages, getSeoPage, saveSeoPage, resetSeoPage, type SeoInput } from "@/lib/services/seo";
import { SEO_PAGES } from "@/lib/seo-pages";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let admin: string;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createUser(db, "+9779841000501", "admin");
});
afterAll(async () => close());

const base = (over: Partial<SeoInput> = {}): SeoInput => ({
  slug: "wedding-anniversary-reminder-nepal", template: "anniversary", title: "Wedding anniversary reminder Nepal | Nabikaran",
  description: "Get an SMS before your wedding anniversary every year, in BS or AD, on your own phone.",
  h1: "Wedding anniversary reminders", intro: "Never miss the day.", nepali: "विवाह वार्षिकोत्सव नबिर्सनुहोस्।",
  remindWhat: ["Your wedding anniversary"], schedule: "7 days and 1 day before.", faqs: [{ q: "Is it yearly?", a: "Yes, it repeats every year." }],
  published: true, sortOrder: 5, ...over,
});

describe("admin-managed SEO pages", () => {
  it("built-in pages (including the new birthday page) are listed without any rows", async () => {
    const pages = await listSeoPages({}, db);
    expect(pages).toHaveLength(SEO_PAGES.length);
    expect(pages.find((p) => p.slug === "birthday-reminder-nepal")).toMatchObject({ source: "built-in", template: "birthday" });
  });

  it("an admin adds a new page; it is published and ordered", async () => {
    await saveSeoPage(admin, base(), db);
    const pages = await listSeoPages({}, db);
    expect(pages[0]).toMatchObject({ slug: "wedding-anniversary-reminder-nepal", source: "custom" });
  });

  it("editing a built-in page overrides it; hiding removes it from the public list; reset restores it", async () => {
    const bb = (await getSeoPage("bluebook-renewal-reminder-nepal", db))!;
    await saveSeoPage(admin, { ...base(), slug: bb.slug, template: bb.template, title: "Bluebook reminder — edited title", published: false, sortOrder: 1 }, db);
    expect(await getSeoPage(bb.slug, db)).toBeNull(); // hidden
    const all = await listSeoPages({ includeHidden: true }, db);
    expect(all.find((p) => p.slug === bb.slug)).toMatchObject({ source: "edited", published: false, title: "Bluebook reminder — edited title" });
    await resetSeoPage(admin, bb.slug, db);
    expect((await getSeoPage(bb.slug, db))!.title).toBe(bb.title);
  });

  it("refuses validity claims, delivery promises and unknown templates", async () => {
    await expect(saveSeoPage(admin, base({ intro: "A licence is valid for 5 years." }), db)).rejects.toMatchObject({ code: "invalid_seo_page" });
    await expect(saveSeoPage(admin, base({ intro: "We offer guaranteed delivery." }), db)).rejects.toMatchObject({ code: "invalid_seo_page" });
    await expect(saveSeoPage(admin, base({ template: "nope" }), db)).rejects.toMatchObject({ code: "invalid_seo_page" });
    await expect(saveSeoPage(admin, base({ slug: "Bad Slug" }), db)).rejects.toBeTruthy();
  });
});
