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
  free_trial: { en: "Free trial", ne: "निःशुल्क ट्रायल", sms: "free trial", group: "business" },
  cancel_deadline: { en: "Cancel by", ne: "रद्द गर्ने अन्तिम दिन", sms: "subscription", group: "business" },
  contract: { en: "Contract", ne: "सम्झौता", sms: "Contract", group: "business" },
  business_registration: { en: "Business Registration", ne: "व्यवसाय दर्ता", sms: "Business Reg.", group: "business" },
  trade_licence: { en: "Trade Licence", ne: "व्यवसाय इजाजत", sms: "Trade Licence", group: "business" },
  pollution_check: { en: "Pollution Check", ne: "प्रदूषण जाँच", sms: "Pollution Check", group: "vehicle" },
  utility_bill: { en: "Electricity / Water Bill", ne: "बिजुली / पानी बिल", sms: "Bill", group: "personal" },
  sim_validity: { en: "SIM Validity", ne: "SIM भ्यालिडिटी", sms: "SIM", group: "personal" },
  bank_kyc: { en: "Bank KYC", ne: "बैंक KYC", sms: "Bank KYC", group: "personal" },
  ssf: { en: "SSF Contribution", ne: "सामाजिक सुरक्षा कोष", sms: "SSF", group: "business" },
  warranty: { en: "Warranty", ne: "वारेन्टी", sms: "Warranty", group: "custom" },
  other: { en: "Other", ne: "अन्य", sms: "Renewal", group: "custom" },
  birthday: { en: "Birthday", ne: "जन्मदिन", sms: "Birthday", group: "occasions" },
  anniversary: { en: "Anniversary", ne: "वार्षिकोत्सव", sms: "Anniversary", group: "occasions" },
  event: { en: "Event", ne: "कार्यक्रम", sms: "Event", group: "occasions" },
} as const;

export type Category = keyof typeof CATEGORY_INFO;
export const CATEGORIES = Object.keys(CATEGORY_INFO) as [Category, ...Category[]];

export const TEMPLATE_GROUPS = ["vehicle", "personal", "insurance", "business", "custom", "occasions"] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

export function categorySmsName(category: string): string {
  return (CATEGORY_INFO as Record<string, { sms: string }>)[category]?.sms ?? "Renewal";
}

export function categoryName(category: string, lang: "ne" | "en"): string {
  const c = (CATEGORY_INFO as Record<string, { en: string; ne: string }>)[category];
  return c ? c[lang] : category;
}

/** Occasions (birthday, anniversary, event) use their own SMS wording and are SMS-only. */
export const OCCASION_CATEGORIES = ["birthday", "anniversary", "event"] as const;
export type OccasionCategory = (typeof OCCASION_CATEGORIES)[number];
/** Categories with their own SMS wording (not "expires"). */
export const WORDED_CATEGORIES = ["birthday", "anniversary", "event", "free_trial", "cancel_deadline"] as const;
export function hasOwnWording(category: string | null | undefined): boolean {
  return (WORDED_CATEGORIES as readonly string[]).includes(category ?? "");
}

export function isOccasion(category: string | null | undefined): category is OccasionCategory {
  return (OCCASION_CATEGORIES as readonly string[]).includes(category ?? "");
}
