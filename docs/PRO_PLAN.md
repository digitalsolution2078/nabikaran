# Nabikaran Pro: research and build plan

Status: **built** (migration `0011_pro`). Operations: `docs/OPERATIONS.md` §16.

Decisions taken:

- Allowances are **message counts**: 100 SMS parts, 100 WhatsApp messages and 400 emails per plan year.
- The free trial lasts **7 days**. It includes all Pro features but **no** included messages.
- Purchases are **final, with no refunds**.
- Email is sent through **Resend**. The API key is pasted in Admin → Pro & email.
- When included messages run out, messages use **wallet credits**. Email costs 1 credit each.
- Price, length and allowances are admin-editable. Pro is off until an admin switches it on.

Branding follows the Basic vs Pro brief: one brand with an orange Pro accent and a PRO badge.

- Basic headline: "Your important dates, remembered."
- Pro headline: "Your renewals, subscriptions and spending — in one place."
- Every plan can repeat monthly, quarterly, yearly or every N months.
- Pro adds subscriptions, free-trial and cancel-by alerts, Insights, Renewal history and email summaries.
- Using credits beyond the included messages needs the customer's permission.
- See `docs/OPERATIONS.md` §16.3.

Not built yet (later):

- screenshot-to-reminder (after cost and accuracy are tested);
- family sharing;
- Google Calendar;
- escalation;
- price-change history;
- Pro-only MCP tools;
- the `/pricing` page;
- email bounce webhooks.

The original proposal follows.

## 1. The offer

| | Basic (free) | Pro |
|---|---|---|
| Price | Free; pay per message from the wallet | **NPR 1,000 per year** (decide: VAT inclusive or exclusive, §6) |
| Included messages | none | **100 SMS + 100 WhatsApp + 500 email** per plan year |
| Reminders, groups, CSV import, birthdays, ChatGPT/Claude | ✓ | ✓ |
| Free push notifications | ✓ | ✓ |
| **Subscription manager** (the main reason to buy) | hidden | ✓ |
| **Email sign-in** | hidden | ✓ |
| **Email reminders** | hidden | ✓ |
| Messages beyond the allowance | wallet credits | wallet credits, same prices |

Main purpose: Pro manages a user's **paid subscriptions and recurring payments**, such as Netflix, YouTube Premium, Spotify, ChatGPT, domains, hosting, insurance premiums, school fees, internet (WorldLink / Vianet) and gym. The user sees what they pay, when, and what they can cancel.

### Decision needed: what "100 SMS credit" means

Today 1 credit = NPR 1, and one SMS segment costs **3 credits** (`pricing_versions`). There are two readings:

- **100 SMS messages** (recommended). This is about NPR 300 of retail value. It is easy to explain on the pricing page.
- **100 credits.** This is only about 33 SMS, which feels small for NPR 1,000.

The build plan below assumes **message allowances** (100 SMS segments, 100 WhatsApp messages, 500 emails), counted separately from wallet credits.

## 2. Unit economics (estimates; check with vendor invoices)

| Item | Cost to us | Notes |
|---|---|---|
| 100 SMS | ~NPR 60–100 | Aggregator wholesale is about NPR 0.6–1.0 per segment. Confirm from the Aakash invoice. |
| 100 WhatsApp utility messages | ~NPR 150–300 | Meta charges per utility template message by the recipient's country. Confirm on Meta's current rate card before launch. |
| 500 emails | ~NPR 10 | Amazon SES charges about US$0.10 per 1,000. Brevo and Resend have free tiers that cover early volume. |
| Payment fees | ~NPR 15–30 | About 1.5–3% on Fonepay or Khalti. Zero on manual QR. |
| VAT (if 13% is included in NPR 1,000) | NPR 115 | |
| **Worst case if every allowance is used** | **~NPR 350–555** | |
| **Gross margin** | **~NPR 445–650 per user per year** | Most users will not use the full allowance (breakage), so the real margin is higher. |

Scale check: 1,000 Pro users bring in about NPR 10 lakh a year in revenue, with roughly NPR 5–6 lakh of margin. The allowance is a cost ceiling, not a fixed cost.

## 3. What to build, in order

### Phase 1: Plan foundation (about 1 week)

1. **Tables** (an additive migration, applied automatically like 0007–0010):
   - `plans`: `code` (basic, pro), price, duration in days, allowances in JSON, active flag. The admin can edit these.
   - `plan_subscriptions`: user, plan, status (active, grace, expired, cancelled), `starts_at`, `ends_at`, payment reference, `granted_by` (for manual or complimentary grants).
   - `allowance_ledger`: append-only, like the wallet. Grants at purchase; debits per message with an idempotency key; expiry at the end of the plan year.
2. **Buying Pro.** The user picks one of two options:
   - **Pay from the wallet.** Debit 1,000 credits and post a `plan` ledger entry. This is the simplest option and reuses the top-up flows that already exist (Fonepay, manual QR, Khalti later).
   - **Pay directly.** A top-up order for NPR 1,000 with a `purpose='plan'` field. When it is confirmed, it activates Pro instead of adding credits.
3. **Gating on the server, not only in the UI.** Add a `requirePlan(user, "pro")` check in the API routes and server components.
   - Basic users never receive Pro data or routes; a Pro URL returns 404 or redirects to upgrade.
   - Basic users see only one **"Upgrade to Pro"** card on the dashboard and in Settings, with the benefits listed. Without this card they cannot find Pro. All Pro screens stay hidden.
4. **Expiry and grace.**
   - The app sends its own reminders before Pro ends: 30, 7 and 1 day before (by SMS, email and push). Unused allowance expires at the end of the plan year.
   - A 7-day grace period follows. After it, the account goes back to Basic.
   - Data is **kept** after the downgrade. Subscription reminders keep running as normal reminders and are paid from wallet credits.
5. **Admin.**
   - Edit the plan price and allowances (new buyers only; current Pro users keep what they bought).
   - Grant, extend or revoke Pro, with a reason and an audit row.
   - Pro list and revenue in the existing reports.
   - Pro status column in the customer CSV export.

### Phase 2: Subscription manager, the core Pro feature (1–2 weeks)

1. **Subscription item.** A reminder that also stores:
   - service name, amount, currency (NPR/USD/INR) and billing cycle (weekly, monthly, quarterly, half-yearly, yearly or custom days);
   - next charge date, payment method (eSewa, Khalti, card ending 1234, bank) and an auto-renew yes/no flag;
   - free-trial end date, a "cancel before" date, and an account email or notes.
2. **Recurrence engine.** It currently repeats **yearly only**. Extend `src/lib/recurrence.ts` and `rolloverYearly` to N months or N days, with month-end clamping (Jan 31 → Feb 28). It must work in both AD and BS.
3. **Dashboard.**
   - Monthly and yearly spend in NPR, by category and by payment method.
   - Upcoming charges for the next 30 days.
   - "Trials ending" and "Price went up" (compares with the last amount entered).
4. **Smart alerts.**
   - Before a free trial ends: "cancel or you will be charged NPR X".
   - Before an annual renewal: "NPR 1,200 for Canva Pro is due in 7 days".
   - For a dual-currency card: "USD charges also add about a 4% card fee".
5. **Ready templates for Nepal.**
   - Global services: Netflix, Spotify, YouTube Premium, ChatGPT Plus, Canva Pro, Google One, iCloud, Microsoft 365, Adobe.
   - Nepal services: WorldLink, Vianet, DishHome, Ncell and NTC packs, domains, hosting.
   - Insurance premiums and school fees.
6. **ChatGPT/Claude (MCP).** Add `list_subscriptions` and `prepare_subscription` tools. They are available to Pro accounts only; a Basic account gets an `upgrade_required` reply with the upgrade link.

### Phase 3: Email (1 week, can run alongside Phase 2)

1. **Provider.**
   - Amazon SES is the cheapest at scale.
   - Brevo or Resend are faster to set up and have free tiers.
   - Hostinger SMTP is not recommended because of its sending limits and deliverability.
2. **DNS for nabikaran.org.** SPF, DKIM and DMARC records, and a sender address such as `reminders@nabikaran.org`. This is one-time work in Hostinger DNS.
3. **Email sign-in (Pro only).**
   - Add and verify an email in Settings with a 6-digit code sent by email.
   - The login page shows "Sign in with email" next to phone OTP and PIN. A Basic account that tries email sign-in is told to use phone sign-in; the reply never says whether an account exists.
   - The phone number stays the main identity. When Pro ends, phone OTP and PIN still work, so no one is locked out.
   - Same protections as OTP: rate limits per email and per IP, codes stored only as hashes, 10-minute expiry.
4. **Email reminder channel.**
   - Add `email` to the channel options (the database check constraint, pricing, and the dispatcher).
   - Emails use the allowance first. When it runs out, either fall back to credits at an admin-set price or stop email sends; the admin chooses which.
   - Add `List-Unsubscribe` headers and handle bounces and complaints (SES SNS or the provider's webhook).

### Phase 4: Allowance billing in the dispatcher (3–4 days)

- At reserve time, take from the user's allowance first (an `allowance_reserve_for_job` step, the same pattern as `wallet_reserve_for_job`). Use wallet credits only for what the allowance does not cover.
- Failed sends refund the allowance, the same way failed sends refund the wallet today.
- Wallet page: "Pro allowance: SMS 63/100 · WhatsApp 90/100 · Email 412/500 · resets on 2027-10-10".

### Phase 5: Launch (2–3 days)

- Pricing page (`/pricing`) and an updated landing page. Terms: plan, refunds and auto-expiry. Privacy: email data.
- Launch offer: the first 500 Pro users get Pro for NPR 799. Referral: a Pro referral gives the referrer one month of extra Pro (the referral settings already support this pattern).
- Tests: purchase, gating (Basic cannot reach any Pro API), expiry and grace, allowance consumption and refunds, and email sign-in abuse limits.

## 4. Risks and how to handle them

| Risk | Handling |
|---|---|
| Hiding all Pro features means no one finds Pro | One upgrade card plus a `/pricing` page. Pro screens themselves stay hidden. |
| WhatsApp cost rises (Meta changes prices) | Allowances are admin-editable for new buyers. Keep WhatsApp at 100 only after checking the live rate card. |
| Email deliverability (Gmail spam) | SPF, DKIM and DMARC before launch; plain-text-first templates; no marketing mail from the reminder sender. |
| Refund disputes | A clear policy: full refund within 7 days if under 10% of the allowance is used, otherwise none. Admin can revoke Pro and refund to the wallet. |
| No card auto-renew in Nepal | Renewal is a one-time payment each year. Our own reminders do the renewal nudging. |

## 5. What the owner needs to decide

1. Is "100 SMS" 100 messages (recommended) or 100 credits?
2. Is NPR 1,000 VAT-inclusive? This depends on IRD and VAT registration. Ask the accountant about e-billing / CBMS rules for the expected turnover.
3. Which email provider: SES (cheapest) or Brevo/Resend (fastest)?
4. When email or WhatsApp allowance runs out: charge credits or stop?
5. Launch price: NPR 1,000 straight, or NPR 799 early-bird for the first 500 users?

## 6. Content and growth angles

- Hook: "तपाईं महिनामा कति subscription तिर्दै हुनुहुन्छ? धेरैजसोलाई थाहै हुँदैन।" (How much do you pay for subscriptions each month? Most people do not know.) Then show a real spend total in the app.
- Short video series: "Netflix free trial सकिनु अघि cancel गर्ने तरिका" (how to cancel a Netflix free trial before it ends), "Dollar card fee ले कति खान्छ?" (how much a dollar card fee costs you), "Domain expire भएर website बन्द" (a domain expires and the website goes down).
- Diaspora: manage parents' WorldLink, DishHome and insurance renewals in Nepal from abroad.
- B2B later: the same subscription manager for small offices (software licences, domains, vehicle papers), as a Business plan.
