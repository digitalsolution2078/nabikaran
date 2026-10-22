/**
 * SEO landing pages. Honest by design: Nabikaran is a reminder service only.
 * Never state official validity periods, fees or deadlines as fact; always
 * tell readers to use the date on their own document and confirm with the
 * issuing office.
 */
export interface SeoPage {
  slug: string;
  template: string | null;
  title: string;
  description: string;
  h1: string;
  intro: string;
  nepali: string;
  remindWhat: string[];
  schedule: string;
  faqs: Array<{ q: string; a: string }>;
}

const COMMON_FAQ = [
  { q: "Does Nabikaran renew my document?", a: "No. Nabikaran only sends reminders. You renew at the relevant office or online service yourself." },
  { q: "Does Nabikaran check government records?", a: "No. Nabikaran does not connect to any government or third-party database. It reminds you about the date you enter from your own document." },
];

export const SEO_PAGES: SeoPage[] = [
  {
    slug: "bluebook-renewal-reminder-nepal",
    template: "bluebook",
    title: "Bluebook renewal reminder Nepal — SMS & WhatsApp | Nabikaran",
    description: "Get SMS or WhatsApp reminders before your vehicle bluebook (billbook) renewal date in Nepal. Enter the date in BS or AD. Reminder service only.",
    h1: "Bluebook renewal reminder for Nepal",
    intro: "Missing your bluebook (billbook) renewal date can mean fines and a wasted day at the transport office. Nabikaran sends you SMS or WhatsApp reminders ahead of the date printed in your bluebook, so you can plan the visit and the payment in time.",
    nepali: "ब्लुबुक नवीकरणको मिति नबिर्सनुहोस्। आफ्नो ब्लुबुकमा लेखिएको मिति (वि.सं. वा ई.सं.) राख्नुहोस्, Nabikaran ले SMS वा WhatsApp मा समयमै सम्झाउँछ।",
    remindWhat: ["Bluebook (billbook) renewal", "Vehicle tax due date", "Third-party vehicle insurance", "Route permit, if your vehicle has one"],
    schedule: "Most people choose reminders 30 days, 7 days and 1 day before, plus one on the day.",
    faqs: [{ q: "Can I enter the date in Bikram Sambat?", a: "Yes. Enter the BS date exactly as written in your bluebook; Nabikaran shows the matching AD date and asks you to confirm it before saving." }, ...COMMON_FAQ],
  },
  {
    slug: "driving-licence-renewal-reminder-nepal",
    template: "driving-licence",
    title: "Driving licence renewal reminder Nepal | Nabikaran",
    description: "SMS and WhatsApp reminders before your Nepal driving licence expiry date. Use the date on your own licence; confirm rules with the Department of Transport Management.",
    h1: "Driving licence renewal reminder for Nepal",
    intro: "Driving with an expired licence is a risk you do not need. Add the expiry date printed on your smart licence and Nabikaran reminds you well before it, giving you time to book and complete the renewal process.",
    nepali: "सवारी चालक अनुमतिपत्रको म्याद सकिनु अघि नै SMS वा WhatsApp सम्झना पाउनुहोस्। आफ्नो लाइसेन्समा लेखिएको मिति राख्नुहोस्।",
    remindWhat: ["Driving licence expiry", "Renewal appointment or document preparation", "Family members' licences on the same account"],
    schedule: "Reminders 60, 30 and 7 days before give time for any appointment or online step.",
    faqs: [{ q: "Does Nabikaran know my licence's validity period?", a: "No. Validity depends on your licence and current rules. Enter the expiry date printed on your licence and confirm renewal steps with the transport office." }, ...COMMON_FAQ],
  },
  {
    slug: "passport-expiry-reminder-nepal",
    template: "passport",
    title: "Passport expiry reminder Nepal — never miss it before travel | Nabikaran",
    description: "Reminders before your Nepali passport expires, months ahead so travel and visa plans are not blocked. SMS or WhatsApp. Reminder service only.",
    h1: "Passport expiry reminder for Nepal",
    intro: "Many countries and airlines expect a passport to remain valid for a period after travel. A reminder months ahead of your passport's expiry gives you time to renew before it affects travel, work or study plans abroad.",
    nepali: "राहदानीको म्याद सकिनुभन्दा धेरै अगाडि नै सम्झना पाउनुहोस्, ताकि विदेश यात्रा, काम वा अध्ययनको योजना नरोकियोस्।",
    remindWhat: ["Passport expiry", "Visa or residence permit expiry", "Work permit or labour approval dates"],
    schedule: "Set reminders 180, 90 and 30 days before so the renewal is done well ahead of any travel.",
    faqs: [{ q: "Can my family abroad use this?", a: "Reminders are sent to a Nepal mobile number by SMS, or by WhatsApp to that number. Many families abroad register a parent's number in Nepal for home documents." }, ...COMMON_FAQ],
  },
  {
    slug: "vehicle-tax-reminder-nepal",
    template: "vehicle-tax",
    title: "Vehicle tax reminder Nepal — SMS before the due date | Nabikaran",
    description: "Never miss your vehicle tax date in Nepal. Enter the due date from your bluebook or tax receipt; get SMS or WhatsApp reminders.",
    h1: "Vehicle tax reminder for Nepal",
    intro: "Late vehicle tax adds penalties. Enter the due date shown on your bluebook or last tax receipt and Nabikaran reminds you before it, every year, as long as you keep the reminder updated.",
    nepali: "सवारी कर तिर्ने मिति नबिर्सनुहोस्। ब्लुबुक वा पछिल्लो रसिदमा भएको मिति राख्नुहोस्।",
    remindWhat: ["Annual vehicle tax", "Bluebook renewal", "Vehicle insurance"],
    schedule: "30 days and 7 days before usually leaves enough time to arrange payment.",
    faqs: [{ q: "Will Nabikaran pay my tax?", a: "No. Nabikaran only reminds you. Pay through the official channels." }, ...COMMON_FAQ],
  },
  {
    slug: "insurance-renewal-reminder-nepal",
    template: "vehicle-insurance",
    title: "Insurance renewal reminder Nepal — vehicle, health, life | Nabikaran",
    description: "Reminders before your vehicle, health or life insurance renewal in Nepal, so cover never lapses. SMS and WhatsApp.",
    h1: "Insurance renewal reminder for Nepal",
    intro: "A lapsed policy can leave you uncovered exactly when you need it. Add the renewal or premium date from your policy document and Nabikaran reminds you ahead of time.",
    nepali: "सवारी, स्वास्थ्य वा जीवन बीमाको नवीकरण मिति अगाडि नै सम्झना पाउनुहोस्, ताकि बीमा नटुटोस्।",
    remindWhat: ["Third-party / comprehensive vehicle insurance", "Health insurance", "Life insurance premium", "Any other policy"],
    schedule: "Reminders 15 days, 7 days and 1 day before suit most policies.",
    faqs: [{ q: "Is Nabikaran linked to my insurer?", a: "No. Use the dates on your own policy and confirm details with your insurer." }, ...COMMON_FAQ],
  },
  {
    slug: "company-renewal-reminder-nepal",
    template: "company-renewal",
    title: "Company renewal & compliance reminders Nepal | Nabikaran",
    description: "Reminders for company renewal, tax filing and business registration dates in Nepal. For owners and accountants. SMS and WhatsApp.",
    h1: "Company renewal and compliance reminders for Nepal",
    intro: "Businesses juggle many dates: company renewal, tax filing, licences, contracts. Put each date from your own records into Nabikaran and get reminders before it, so nothing slips while you run the business.",
    nepali: "कम्पनी नवीकरण, कर फाइलिङ र व्यवसायका अन्य मितिहरूको समयमै सम्झना।",
    remindWhat: ["Company or firm renewal", "Tax return filing", "Trade or professional licence", "Contract renewal", "Software or hosting subscriptions"],
    schedule: "For filing deadlines, reminders 30, 14 and 3 days before leave time to prepare documents.",
    faqs: [{ q: "Does Nabikaran know the statutory deadlines?", a: "No. Deadlines depend on your entity and current rules. Enter the dates your accountant or the office gives you." }, ...COMMON_FAQ],
  },
  {
    slug: "domain-renewal-reminder-nepal",
    template: "domain",
    title: "Domain & hosting renewal reminder Nepal | Nabikaran",
    description: "Never lose your website or .com.np domain to a missed renewal. SMS and WhatsApp reminders before domain and hosting expiry.",
    h1: "Domain and hosting renewal reminder for Nepal",
    intro: "An expired domain takes your website and email offline. Add the expiry dates from your registrar and hosting account and Nabikaran reminds you before they lapse.",
    nepali: "डोमेन वा होस्टिङको म्याद सकिनु अघि सम्झना पाउनुहोस्, ताकि वेबसाइट र इमेल बन्द नहोस्।",
    remindWhat: ["Domain name (.com, .com.np and others)", "Web hosting", "SSL certificate", "Software licences"],
    schedule: "Reminders 30 and 7 days before give time to renew and update payment details.",
    faqs: [{ q: "Can Nabikaran renew my domain automatically?", a: "No. Nabikaran is a reminder service; renew with your registrar." }, ...COMMON_FAQ],
  },
  {
    slug: "birthday-reminder-nepal",
    template: "birthday",
    title: "Birthday reminder Nepal — SMS before friends' birthdays | Nabikaran",
    description: "Never forget a friend's or family member's birthday. Add birthdays in BS or AD, or import a whole list, and get an SMS on your own phone every year.",
    h1: "Birthday reminders for Nepal, every year",
    intro: "Facebook does not always remind you, and phone calendars get lost when you change phones. Add your friends' and family's birthdays once, in Bikram Sambat or AD, and Nabikaran sends an SMS to your own number a day before and on the day, every year.",
    nepali: "साथी र परिवारको जन्मदिन नबिर्सनुहोस्। एकपटक वि.सं. वा ई.सं. मा जन्म मिति राख्नुहोस्, हरेक वर्ष तपाईंकै फोनमा SMS आउँछ।",
    remindWhat: ["Friends' and family birthdays", "Wedding and other anniversaries", "Import a whole list from Excel or Google Sheets", "Keep them in groups like \"Friends' birthdays\""],
    schedule: "Most people choose 1 day before and on the day; the reminder repeats every year by itself.",
    faqs: [
      { q: "Does Nabikaran send an SMS to my friend?", a: "No. Every SMS goes only to your own verified number. Nabikaran reminds you, so you can wish them yourself." },
      { q: "Can I enter the birth date in Bikram Sambat?", a: "Yes. Enter it in BS or AD; the reminder lands on the same BS or AD day each year." },
      { q: "Can I add many birthdays at once?", a: "Yes. Paste a list or upload a CSV with name and date; you see the cost of every row before importing." },
      ...COMMON_FAQ,
    ],
  },
  {
    slug: "ward-business-registration-renewal-nepal",
    template: "ward-business-registration",
    title: "Ward business registration renewal reminder Nepal | Nabikaran",
    description: "Renew your ward (municipality) business registration on time. Enter the date on your certificate; get app, SMS or WhatsApp reminders.",
    h1: "Ward business registration renewal reminder",
    intro: "Every shop, café, workshop and consultancy renews its ward business registration each year, and late renewal adds a fine. Enter the date from your certificate and Nabikaran reminds you ahead of it, every year.",
    nepali: "पसल, क्याफे, वर्कशप, कन्सल्टेन्सी — हरेक वर्ष वडा व्यवसाय दर्ता नवीकरण गर्नुपर्छ। प्रमाणपत्रको मिति राख्नुहोस्, समयमै सम्झना पाउनुहोस्।",
    remindWhat: ["Ward / municipality business registration", "Trade or firm licence", "PAN / VAT filing", "Company (OCR) renewal"],
    schedule: "30 days, 7 days and the due day give time to collect last year's certificate, tax clearance and photos.",
    faqs: [{ q: "Which office renews it?", a: "Your ward office in the municipality where the business is registered. Fees and papers differ by ward; confirm there." }, ...COMMON_FAQ],
  },
  {
    slug: "pollution-check-reminder-nepal",
    template: "pollution-check",
    title: "Vehicle pollution check (green sticker) reminder Nepal | Nabikaran",
    description: "Don't get fined for an expired pollution sticker. Enter the date on your sticker; Nabikaran reminds you before it expires.",
    h1: "Vehicle pollution check reminder",
    intro: "Traffic police check the green sticker and the transport office asks for it at tax time. Enter the expiry date from your sticker or slip and get a reminder before it runs out.",
    nepali: "ग्रीन स्टिकर सकिएकोमा जरिवाना नतिर्नुहोस्। स्टिकरको मिति राख्नुहोस्, सकिनुअघि सम्झना पाउनुहोस्।",
    remindWhat: ["Pollution check sticker", "Vehicle tax", "Bluebook renewal", "Third-party insurance"],
    schedule: "7 days and 1 day before are enough: the test takes minutes at an authorised centre.",
    faqs: [{ q: "Where is the test done?", a: "At authorised pollution testing centres, often at petrol pumps and workshops. Bring the vehicle and bluebook." }, ...COMMON_FAQ],
  },
  {
    slug: "electricity-water-bill-reminder-nepal",
    template: "electricity-bill",
    title: "Electricity and water bill due date reminder Nepal | Nabikaran",
    description: "Never pay a late fee on your NEA electricity or water bill. Enter the due date and get an app, SMS or WhatsApp reminder.",
    h1: "Electricity and water bill reminder",
    intro: "A missed due date means a late fee and, eventually, a cut line. Enter the due date from your NEA or water bill once, set it to repeat monthly, and Nabikaran reminds you every month.",
    nepali: "NEA बिजुली वा खानेपानीको बिल ढिलो तिरेर जरिवाना नतिर्नुहोस्। मिति एकपटक राख्नुहोस्, हरेक महिना सम्झना पाउनुहोस्।",
    remindWhat: ["NEA electricity bill", "KUKL / khanepani water bill", "Internet (WorldLink, Vianet) and DishHome", "SIM validity and data packs"],
    schedule: "3 days and 1 day before, repeating every month.",
    faqs: [{ q: "Can Nabikaran pay the bill?", a: "No. Pay through the NEA app, a wallet or the counter. Nabikaran only reminds you." }, ...COMMON_FAQ],
  },
  {
    slug: "sim-validity-reminder-nepal",
    template: "sim-validity",
    title: "SIM validity and data pack expiry reminder Nepal | Nabikaran",
    description: "Keep your NTC or Ncell prepaid SIM and data pack alive. Enter the validity end date; Nabikaran reminds you before it is cut off.",
    h1: "SIM validity and data pack reminder",
    intro: "A prepaid SIM that is not recharged in time loses its validity, and a number used for banking and OTPs is hard to replace. Enter the date from your NTC or Ncell app and get a reminder first.",
    nepali: "NTC वा Ncell को प्रिपेड SIM र डाटा प्याक समयमै रिचार्ज नगरे नम्बर नै जान सक्छ। एपमा देखिने मिति राख्नुहोस्।",
    remindWhat: ["Prepaid SIM validity", "Data or voice pack expiry", "Internet subscription", "Parents' SIM abroad or in the village"],
    schedule: "3 days and 1 day before, repeating monthly for packs.",
    faqs: [{ q: "Does this work for my parents' number?", a: "Yes. Add their number under Family & clients and the reminder SMS goes to their phone, signed with your name." }, ...COMMON_FAQ],
  },
  {
    slug: "bank-kyc-update-reminder-nepal",
    template: "bank-kyc",
    title: "Bank KYC update deadline reminder Nepal | Nabikaran",
    description: "Banks restrict accounts when KYC is not updated by the deadline. Enter the date from your bank's SMS and get a reminder before it.",
    h1: "Bank KYC update reminder",
    intro: "Nepali banks ask customers to update KYC by a date, and accounts can be restricted after it. Enter the date from your bank's SMS or letter and Nabikaran reminds you ahead of it.",
    nepali: "बैंकले तोकेको KYC अद्यावधिक मिति नबिर्सनुहोस्, नत्र खाता रोकिन सक्छ। बैंकको SMS मा भएको मिति राख्नुहोस्।",
    remindWhat: ["Bank KYC update", "Dormant account reactivation", "Debit card expiry", "Fixed deposit maturity"],
    schedule: "30 days, 7 days and 1 day before leave time to visit the branch or update online.",
    faqs: [{ q: "Is Nabikaran connected to my bank?", a: "No. Enter the date your bank gave you; Nabikaran only reminds you." }, ...COMMON_FAQ],
  },
  {
    slug: "ssf-contribution-reminder-nepal",
    template: "ssf-contribution",
    title: "SSF contribution due date reminder Nepal | Nabikaran",
    description: "Employers: never miss the Social Security Fund monthly contribution deadline. Enter the due date; get app, SMS or WhatsApp reminders.",
    h1: "SSF contribution reminder for employers",
    intro: "Late SSF contributions attract penalties. Enter the monthly due date from your SSF portal, set it to repeat monthly, and Nabikaran reminds your accounts team every month.",
    nepali: "सामाजिक सुरक्षा कोषको मासिक योगदान ढिलो गर्दा जरिवाना लाग्छ। SSF पोर्टलको मिति राख्नुहोस्, हरेक महिना सम्झना पाउनुहोस्।",
    remindWhat: ["SSF monthly contribution", "PAN / VAT return", "Company annual filing (OCR)", "Trade licence"],
    schedule: "3 days and 1 day before, repeating every month.",
    faqs: [{ q: "Can a company share reminders with staff?", a: "Yes. Add colleagues under Family & clients, or ask for business tools to manage many recipients." }, ...COMMON_FAQ],
  },
  {
    slug: "whatsapp-renewal-reminder-nepal",
    template: null,
    title: "WhatsApp renewal reminders Nepal — bluebook, licence, passport | Nabikaran",
    description: "Get renewal reminders on WhatsApp as well as SMS. Approved WhatsApp templates, consent-based, reply STOP anytime. Prepaid credits, no subscription.",
    h1: "Renewal reminders on WhatsApp, for Nepal",
    intro: "Prefer WhatsApp? Choose SMS, WhatsApp or both for each reminder. WhatsApp messages use approved templates, are sent only after you give consent, and you can reply STOP at any time. You see the exact message and its credit cost before saving.",
    nepali: "SMS सँगै WhatsApp मा पनि नवीकरण सम्झना। तपाईंको सहमतिपछि मात्र पठाइन्छ; जुनसुकै बेला STOP लेखेर रोक्न सकिन्छ।",
    remindWhat: ["Any document or renewal in your account", "SMS only, WhatsApp only, or both", "Delivery and read status as reported by WhatsApp"],
    schedule: "Pick the same schedule for both channels; each message is priced and shown before you save.",
    faqs: [
      { q: "Is WhatsApp delivery guaranteed?", a: "No. Nabikaran shows the delivery and read status that WhatsApp reports, but cannot guarantee delivery to a phone." },
      { q: "What if a WhatsApp message fails?", a: "If WhatsApp reports a failure, the credits for that message are returned automatically." },
      ...COMMON_FAQ,
    ],
  },
];

export function seoPage(slug: string): SeoPage | undefined {
  return SEO_PAGES.find((p) => p.slug === slug);
}
