/**
 * Reminder categories. `sms` is the GSM-7 name used in the SMS when the
 * user's own label cannot be sent as-is (e.g. it is written in Devanagari).
 */
export const CATEGORY_INFO = {
  bluebook: { en: "Bluebook", ne: "ब्लुबुक", sms: "Bluebook", group: "vehicle" },
  licence: { en: "Driving Licence", ne: "सवारी चालक अनुमतिपत्र", sms: "Driving Licence", group: "vehicle" },
  vehicle_tax: { en: "Vehicle Tax", ne: "सवारी कर", sms: "Vehicle Tax", group: "vehicle" },
  vehicle_permit: { en: "Vehicle Permit", ne: "सवारी परमिट", sms: "Vehicle Permit", group: "vehicle" },
  insurance: { en: "Insurance", ne: "बीमा", sms: "Insurance", group: "insurance" },
  health_insurance: { en: "Health Insurance", ne: "स्वास्थ्य बीमा", sms: "Health Insurance", group: "insurance" },
  life_insurance: { en: "Life Insurance", ne: "जीवन बीमा", sms: "Life Insurance", group: "insurance" },
  passport: { en: "Passport", ne: "राहदानी", sms: "Passport", group: "personal" },
  visa: { en: "Visa", ne: "भिसा", sms: "Visa", group: "personal" },
  work_permit: { en: "Work Permit", ne: "श्रम स्वीकृति", sms: "Work Permit", group: "personal" },
  tax_filing: { en: "Tax Filing", ne: "कर विवरण", sms: "Tax Filing", group: "business" },
  company: { en: "Company Renewal", ne: "कम्पनी नवीकरण", sms: "Company Renewal", group: "business" },
  domain: { en: "Domain", ne: "डोमेन", sms: "Domain", group: "business" },
  hosting: { en: "Hosting", ne: "होस्टिङ", sms: "Hosting", group: "business" },
  subscription: { en: "Subscription", ne: "सदस्यता", sms: "Subscription", group: "business" },
  contract: { en: "Contract", ne: "सम्झौता", sms: "Contract", group: "business" },
  warranty: { en: "Warranty", ne: "वारेन्टी", sms: "Warranty", group: "custom" },
  other: { en: "Other", ne: "अन्य", sms: "Renewal", group: "custom" },
} as const;

export type Category = keyof typeof CATEGORY_INFO;
export const CATEGORIES = Object.keys(CATEGORY_INFO) as [Category, ...Category[]];

export const TEMPLATE_GROUPS = ["vehicle", "personal", "insurance", "business", "custom"] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

export function categorySmsName(category: string): string {
  return (CATEGORY_INFO as Record<string, { sms: string }>)[category]?.sms ?? "Renewal";
}

export function categoryName(category: string, lang: "ne" | "en"): string {
  const c = (CATEGORY_INFO as Record<string, { en: string; ne: string }>)[category];
  return c ? c[lang] : category;
}
