# Nabikaran — follow-up development report

Scope: UI/UX redesign, localization and calendar, live Nepal clock, document templates, admin RBAC, wallet and manual QR top-ups, SMS encoding and cost, MCP explanation, international users. Each item records what was built, how it was verified, and what is still open.

## 1. Application audit (starting point)

| Area | State found |
|---|---|
| Backend | Solid. Append-only credit ledger, idempotent payments, SQL-enforced reservations, SKIP LOCKED dispatcher, OAuth 2.1 + MCP server. Kept as is. |
| UI | Functional but plain. Top nav only, no mobile navigation, minimal empty/loading/error states, mixed languages. |
| Roles | Only `user` / `admin`; admin granted by manual SQL update; no admin console beyond pricing and OAuth clients. |
| Wallet | Fixed Khalti packs only; no custom amount; no QR/manual path. |
| SMS | Templates allowed Devanagari (UCS-2, 70 chars per segment) so Nepali reminders often cost 2–3 segments. |
| Dates | BS input existed; no saved language/date preference; no clock. |

## 2. Problems identified and fixed

1. Devanagari SMS made cost unpredictable. Now GSM-7 only, guaranteed single segment.
2. Owner admin access depended on hand-written SQL. Now a one-time, audited bootstrap function.
3. Customers could not pay any amount except fixed packs. Now custom amounts with limits.
4. No way to accept Fonepay QR payments safely. Now a verified manual flow.
5. **Bug:** dashboard could crash with `a.due_at_utc.localeCompare is not a function` because Postgres returns a `Date`. Fixed in `listJobsForUser` with a regression test.
6. Users could pick a BS date already in the past and see an empty preview. The details step now flags the error and blocks *Next*.
7. Admins could approve credit adjustments to their own wallet. Refused now.

## 3. UI/UX plan (implemented)

- **Brand:** purple primary, white surfaces, yellow and orange accents, inspired by Digital Solution. The reference site was not reachable from the build environment, so this is **not** a pixel match. Send the URL or screenshots to align it.
- **Fonts:** Inter (Latin), Mukta (Devanagari), Poppins (headings).
- **Layout:** sidebar on desktop; top bar plus bottom navigation with a central *Add* button on mobile; no horizontal scroll at 390 px (tested).
- **States:** every list has an empty state with a call to action; forms show inline errors; confirm dialogs for money actions; dark mode via system setting.
- **Landing page:** value proposition, sample SMS bubbles, how-it-works, pricing explanation.

## 4. New pages and components

| Pages | Purpose |
|---|---|
| `/` | Landing |
| `/dashboard` | Credits, reserved, active reminders, SMS sent, expiring soon, upcoming reminders, recent SMS |
| `/renewals`, `/renewals/new`, `/renewals/[id]` | Status tabs; 4-step template wizard; detail with schedule |
| `/wallet`, `/wallet/topup/[id]`, `/wallet/history` | Add credits; QR pay page; ledger |
| `/settings` | Name, interface language, date format, SMS language |
| `/admin` + `users`, `users/[id]`, `wallet/topups`, `sms`, `templates`, `audit`, `settings` | Admin console |

Components: `Shell`, `Prefs` (onboarding + provider), `LiveClock`, `Icon`, `AddCredits`, `QrSubmit`, `CopyField`, `RenewalForm` (wizard), and admin editors under `src/components/admin/`.

## 5. Database changes — migration `0004_admin_wallet_templates.sql`

Additive only; no table resets. Applied automatically by the `migrate` container.

- `users`: role `super_admin`, `email`, `ui_language`, `date_format`.
- `bootstrap_super_admin(phone)` — one-time.
- `app_settings` — top-up limits, QR settings.
- `manual_topup_requests`, `topup_receipts`, `approve_manual_topup`, `reject_manual_topup`.
- `wallet_direct_adjustment` for super admins.
- New GSM-7 SMS templates (old Devanagari ones deactivated, kept for history).
- `document_templates` with 20 seeds; `renewal_items.template_slug`.
- Trigger that makes `audit_events` append-only.

## 6. Admin roles and owner access

See `docs/ADMIN_AND_PAYMENTS.md` §1–2. In short: sign in once with OTP, run `select bootstrap_super_admin('+977…')` on the VPS, sign in again, open `/admin`.

## 7. Wallet and QR flow

See `docs/ADMIN_AND_PAYMENTS.md` §3–5. The static Fonepay QR is shown unmodified with an exact amount and a unique reference. Approval needs a bank statement reference that can be used only once. Approval is idempotent and concurrency-safe.

## 8. SMS cost and encoding

- Templates: English (`en-NP`) or Romanized Nepali (`ne-NP`), e.g. `Nabikaran: Tapaiko Bluebook ko myad 7 din pachhi (2026-11-02) sakinchha. Samayamai nabikaran garnuhos.`
- Every message is GSM-7 and ≤ 160 characters. Extended characters (`{ } [ ] ~ \ | ^ €`) count as two. Labels containing Devanagari or other non-GSM text fall back to the template's English SMS label. Long labels are shortened to fit, and the wizard says so.
- The wizard shows the exact text, length, segment count and credit cost per SMS before confirmation.
- Admin template edits are rejected if the worst case (30-character label, 999 days, longest date) exceeds one segment.
- Credits per SMS are configurable (default 3). Provider cost is never hardcoded. Confirm with Aakash that GSM-7 messages of ≤ 160 characters bill as one unit on your account.

## 9. Localization and calendar

- First visit: choose नेपाली / English and BS / AD. Saved in a cookie and `localStorage`. When signed in it is saved to the profile, and the profile wins on later logins on other devices.
- Every date renders in the chosen calendar with Nepali digits in Nepali mode. Reminders can be entered in BS or AD, with the converted date shown alongside.
- BS conversion supports 2000–2090 BS and rejects invalid days per month.
- Date-only expiries are stored as 09:00 Nepal time, which prevents off-by-one-day shifts across time zones.
- Live clock in the header: weekday, date in the chosen calendar, time with "NPT", ticking every second, with no hydration mismatch (tested).

## 10. MCP: what it is and how it works here

**What it is.** The Model Context Protocol lets assistants like Claude or ChatGPT call Nabikaran's tools on a user's behalf.

**How it talks to the backend.** The MCP endpoint (`/mcp`) calls the same core service layer as the website (`src/lib/core`). It uses the same database, the same wallet, the same pricing and the same SMS templates. There is no separate data store.

**Account linking.** OAuth 2.1 with PKCE. The user signs in with their phone OTP on Nabikaran's own page and approves the requested scopes. The assistant never chooses or sees which account; it only holds a token bound to the user who approved it.

**Creating reminders.** `prepare_reminder` returns the schedule, SMS text and cost without touching the wallet. `confirm_reminder` reserves credits only after the user explicitly confirms the prepared summary.

**Tools available now:** `get_account`, `get_credit_balance`, `list_reminders`, `prepare_reminder`, `confirm_reminder`, `update_reminder`, `cancel_reminder`.

**Document images.** When a user shares a photo of a licence or bluebook, the *assistant* reads it with its own vision model and passes structured fields (document type, label, expiry date, calendar) to `prepare_reminder`. Nabikaran never receives or stores the image. The user still confirms the extracted date before anything is reserved.

| Works immediately on our side | Depends on the client |
|---|---|
| OAuth linking, all seven tools, prepare→confirm, scope checks, audit | Image reading quality, how the confirmation is displayed, whether the client supports remote MCP servers and OAuth |

Details: `docs/MCP_ARCHITECTURE.md`.

## 11. International users — recommendation

| Option | Description | Verdict |
|---|---|---|
| A. Nepal-only | +977 numbers, SMS via Aakash | **Recommended for V1** |
| B. Global SMS | Second provider (e.g. Twilio) for non-Nepal numbers | Later. Per-SMS cost is 5–20× higher; needs per-country pricing and sender ID rules |
| C. Hybrid | Diaspora users register a Nepal number for SMS and receive email or WhatsApp copies abroad | **Best next step** after V1 |

Do not assume Aakash delivers internationally; confirm in writing first. Diaspora angle: a parent's or family member's +977 number can receive the reminders, so families abroad can manage renewals back home.

## 12. Testing results

| Suite | Result |
|---|---|
| Unit + integration (Vitest, real migrations on PGlite) | 126 / 126 passed across 11 files |
| Typecheck | Clean |
| Production build (`next build`) | Clean |
| Browser end-to-end (Playwright, Chromium, mobile 390 px + desktop) | 26 / 26 checks passed |

Covered: onboarding and persistence, mobile layout, clock, auth and admin 403s, one-time bootstrap, QR top-up lifecycle, four concurrent approvals crediting once, bank reference reuse, self-approval refusal, receipt type spoofing, direct adjustments, audit immutability, GSM-7 segmentation and billing, BS/AD conversion and boundaries, scheduling, no hydration errors.

Not tested: live Fonepay, Khalti or Aakash calls (no credentials in this environment), and real phones.

## 13. Commits

Branch `claude/bold-brahmagupta-zglkbf`:

1. *Admin RBAC, QR top-ups, custom amounts, GSM-7 SMS, document templates* — migration, services, APIs, tests.
2. *Redesigned UI, Nepali/English + BS/AD preferences, live clock, admin console* — pages, components, design system, docs.

No credentials are committed; only `.env.example` files are tracked.

## 14. Hostinger VPS deployment (update)

Production runs in `/docker/nabikaran` and deploys automatically from `main`; commands are in `docs/DEPLOY_VPS.md` §1–§3.

Then:

1. Make yourself super admin once (`docs/ADMIN_AND_PAYMENTS.md` §2).
2. Admin → Settings & roles: confirm QR merchant details and tick *verified*.
3. Admin → SMS & pricing: set credits per SMS after confirming your Aakash rate.
4. If Khalti is not ready, set `PAYMENT_GATEWAY=none` in the stack's environment. Customers then see QR top-up only.

Every deploy backs up the database to `/root/backups/nabikaran/` first.
