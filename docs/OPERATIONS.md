# Operations guide

## 1. Staff roles

| Role | Can |
|---|---|
| Read-only auditor | View every admin screen. Change nothing. |
| Template / content manager | Edit document templates (and see message templates). |
| Support admin | Add customer notes; request credit adjustments (another person approves). |
| Finance reviewer | Approve / reject QR top-ups; approve adjustment requests. |
| Operations admin | Support + finance + templates + MCP client kill-switch. |
| Super admin | Everything: roles, channel pricing, WhatsApp, settings, direct adjustments. |

Rules enforced on the server (and for top-ups also inside the database):

- Nobody approves their own top-up or adjusts their own wallet.
- Nobody changes their own role.
- The last super admin cannot be demoted.
- With fewer than two people able to review top-ups, the Top-ups page shows **"Add another admin before approving manual top-ups."** Promote a trusted person to *Finance reviewer*.

## 2. WhatsApp (Meta Cloud API) setup

1. In Meta Business Manager, create a WhatsApp Business app and add your business phone number. Note the **Phone number ID** and **WhatsApp Business Account ID**.
2. Create two **Utility** templates per language with three body variables, for example:
   - `nabikaran_renewal_reminder` (en): `Nabikaran reminder: your {{1}} expires in {{2}} day(s) on {{3}}. Please renew it on time.`
   - `nabikaran_renewal_due_today` (en): `Nabikaran reminder: your {{1}} expires today ({{3}}). Please renew it on time.`
   - The same two in Nepali (`ne`) if you want Nepali WhatsApp messages.
   Wait until Meta marks them **Approved**.
3. Create a permanent System User access token with `whatsapp_business_messaging`. Copy the app secret from the app's Basic settings. Choose any long random verify token.
4. On the server, add to the production stack's environment in `/docker/nabikaran` (never in the admin panel; see `docs/DEPLOY_VPS.md` §2):
   ```
   WHATSAPP_PROVIDER=meta
   WHATSAPP_ACCESS_TOKEN=<system user token>
   WHATSAPP_APP_SECRET=<app secret>
   WHATSAPP_VERIFY_TOKEN=<your random string>
   ```
   Then apply it with `bash /root/nabikaran-deploy.sh` (recreates the web container; a few minutes of downtime).
5. In Meta → WhatsApp → Configuration → Webhook, set the callback URL to `https://<your-domain>/api/webhooks/whatsapp` and the verify token. Subscribe to the **messages** field. Admin → Channels & pricing then shows *Webhook verified*.
6. In **Admin → Channels & pricing**:
   - enter the Phone number ID and WABA ID;
   - map the four templates (name + language + body exactly as approved);
   - set the WhatsApp credit price from your Meta rate card;
   - tick **WhatsApp reminders enabled**.
7. Test with your own account: add a reminder with channel *WhatsApp*, then use the Messages page to watch it go to *Sent → Delivered → Read*.

Customers must tick a consent box the first time they choose WhatsApp, and can reply **STOP** to opt out. AI assistants cannot give that consent.

## 3. Billing and refund policy (both channels)

| Event | Credits |
|---|---|
| Reminder saved | Every message reserved up front; a reminder cannot be saved without enough credits |
| Provider accepts the message | Charged at the price booked when the reminder was saved |
| Provider rejects before accepting | Reservation released (never charged) |
| Provider later reports failure (SMS DLR / WhatsApp webhook) | Charge reversed automatically |
| Outcome unknown (timeout) | Held; reconciled by report or webhook, never re-sent blindly; WhatsApp unresolved after 6 h → released |
| WhatsApp disabled after scheduling | Job failed, credits returned |
| Successful sign-in | Sign-in fee (default 1 credit), may go negative; lock below −5 |

Provider unit counts that differ from the quote are logged for your reconciliation; the customer pays the quote.

## 4. SMS delivery reports (Aakash)

The overview shows accepted vs delivered separately. If Aakash accepts SMS but no delivery status comes back for a week, the overview warns. The reconciler also records `sms.report_unavailable` audit events with a sample of the provider's reply.

Ask Aakash for the exact v3 delivery-report request (URL, method, parameter names). If it differs from `AAKASH_REPORT_URL` with a JSON POST of `auth_token` and `ids`, adjust `src/lib/providers/sms/aakash.ts` (the `report()` function only).

## 5. Account closure and credits

Closure cancels all scheduled messages and releases their reservations. Unused credits are not refunded, except a duplicate or erroneous payment reported within 30 days (Terms §4–5). The balance at closure is recorded in the audit log (`account.closed`).

## 6. Rate limits (per window, Postgres-backed)

| Endpoint | Limit |
|---|---|
| OTP request | 3 per phone / 15 min; 10 per IP / hour |
| OTP verify | 30 per IP / 10 min, plus 5 attempts per code |
| Top-up start | 10 per user / hour |
| QR submit | 20 per user / hour |
| QR status check | 40 per user / minute |
| Reminder preview | 120 per user / minute |
| Reminder create / edit / status | 60 per user / minute |
| Admin top-up decision | 60 per admin / minute |
| WhatsApp webhook | 1200 per IP / minute |
| MCP tools and OAuth | existing per-client limits |

## 7. If the customer dashboard shows an error

The dashboard isolates its data. A failing query renders a short notice instead of a server error, and the server log contains `[dashboard] summary failed for user <id>: <error>`. Any other page error shows an **Error ID** that matches the server log:

```bash
docker logs --since 1h nabikaran-web-1 2>&1 | grep -iE "error|dashboard"
```

## 8. Installable app (PWA)

Customers can install Nabikaran on their phone or computer. There is no app store listing.

| Platform | How the customer installs |
|---|---|
| Android (Chrome) | An **Install** banner on the dashboard and a card in **Settings**, or the browser menu → *Install app* |
| iPhone (Safari) | Settings shows the steps: Share → *Add to Home Screen* |

How it is built:

- **Manifest:** `public/manifest.webmanifest`.
  - Icons in 192, 512 and maskable 512 sizes.
  - Shortcuts to Add reminder, Reminders and Wallet.
  - `start_url` is `/dashboard?source=pwa`, so installed-app visits can be counted in analytics.
- **Service worker:** `public/sw.js`.
  - Caches only static files (hashed JS/CSS, icons, manifest).
  - Page HTML and `/api/*` are never cached, so balances, reminders and payments are always live, and a shared phone never shows someone else's data from cache.
  - Without a connection, page loads show `public/offline.html`, which reloads by itself when the connection returns.
- **Updates:** after changing `sw.js` or the precached files, bump `VERSION` in `sw.js` so old caches are removed.

Reminders do not depend on the app. SMS and WhatsApp are sent from the server whether or not the app is installed or open.

## 9. Groups, yearly reminders and CSV import

- **Groups** (`reminder_groups`, migration `0007`): customers organise reminders, for example "Friends' birthdays", at **Reminders → Manage groups**. Deleting a group either keeps its reminders (they become ungrouped) or cancels them and releases their reserved credits.
- **Occasions:** the categories `birthday`, `anniversary` and `event` use their own SMS wording (English or Romanized Nepali, one GSM-7 segment) and are **SMS only**. Every message still goes only to the customer's own verified number. A birthday reminder tells the customer about the friend's birthday; it never messages the friend.
- **Repeat every year:** a birth date in any past year is moved to its next occurrence. The month and day are kept in `repeat_anchor`, so 29 Feb and BS day 32 survive years where they are clamped.
- **Yearly rollover:** the reconciler (every 5 minutes) handles a yearly reminder once the date is more than 6 hours past and its messages have finished.
  - It moves the reminder to next year's date and reserves the new messages.
  - If the wallet is short at that moment, the messages wait as *awaiting credits*. The dashboard asks the customer to top up, and the top-up schedules them automatically.
  - The audit log records `reminder.rollover`.
- **CSV import** (**Reminders → Import**):
  - **File:** up to 300 rows and 200 KB. Comma, semicolon or tab separated, so a paste from Excel or Google Sheets works.
  - **Columns:** `name` and `date` are required. Optional: `calendar`, `remind` (days before, e.g. `7;1;0`), `repeat`, `time`, `notes`, `for`.
  - **Preview:** prices every row and lists each row's errors.
  - **Import:** all-or-nothing in one transaction. Every message is reserved, or nothing is saved.
  - **Errors:** rows with errors must be explicitly skipped.
  - **Safety:** the import is idempotent.
  - **Audit:** recorded as `reminder.import`.

Production has no migrate step that this repository controls, so the app applies missing additive schema steps itself when it starts (`src/instrumentation.ts`, `src/lib/schema-steps.ts`).
- The steps are exact copies of migration files, and a test keeps them in sync.
- The first start that applies a step records `schema.ensure_applied` in the audit log.
- To turn this off, set `SCHEMA_AUTO_ENSURE=off`.

After every successful deploy, the **Production check** workflow calls `https://nabikaran.org/api/health` from GitHub's servers. It fails unless the database answers and every value in `schema` is `true`.

To check by hand on the server:

```bash
docker exec nabikaran-db-1 psql -U nabikaran -d nabikaran -c "select * from _schema_migrations order by 1 desc limit 3"
docker exec nabikaran-db-1 psql -U nabikaran -d nabikaran -c "\d reminder_groups"
```

## 10. SEO landing pages (admin)

**Admin → SEO pages** lists every page under `/renewal-reminder/…`.
- **Built-in pages** come from `src/lib/seo-pages.ts`.
- An admin with *templates.manage* (content manager, operations admin, super admin) can:
  - **edit** a built-in page (title, Google description, heading, text, Nepali paragraph, schedule, FAQs, order);
  - **hide** a page;
  - **reset** a page to its built-in text;
  - **add** new pages.
- Changes are live immediately and appear in `sitemap.xml`.
- Saving is refused when the text states official validity periods or deadlines as fact, or promises delivery or renewals.
- Every save and reset is recorded in the audit log.

Storage: table `seo_pages` (migration `0008`). Production applies it automatically at start-up.

## 11. Uptime

The **Production check** workflow runs every 30 minutes from GitHub's servers (site, database, schema, MCP). GitHub emails the repository owner when it fails. **Actions → Production check** shows the history.

## 12. Referral programme

Settings live under **Admin → Settings & roles → Referral programme**:
- on/off;
- credits for the inviter and for the new customer;
- qualifying paid top-up amount;
- most rewards per inviter;
- an optional campaign line.

The same page shows the **Referral results**: invited, rewarded, bonus credits paid, and the top inviters.

How it works:
- **Invite link:** every customer has an invite link `nabikaran.org/r/CODE` under **Settings → Invite friends**, with WhatsApp, Viber and share buttons. The link is remembered for 30 days.
- **Who counts:** only a **new** account opened through the link is recorded as invited.
- **When bonuses are paid:**
  - Both bonuses are paid once, when the new customer's *paid* top-ups reach the threshold.
  - All three top-up paths trigger the payment: Khalti/gateway, Fonepay dynamic QR, and manual QR approval.
  - Sign-ups alone earn nothing, so fake accounts cannot farm credits.
- **Cap:** above the per-inviter cap, the new customer still gets the bonus and the inviter does not.
- **Ledger:** bonuses are ledger type `referral` ("Referral bonus" in the statement), credited by `wallet_credit_referral`, which is idempotent per reward and side.

## 13. PIN sign-in

Customers can set an optional 4–6 digit PIN in **Settings → Quick sign-in PIN**. They then use **Sign in with mobile + PIN** on the login page. No SMS is sent, so no sign-in fee is charged.

| Topic | Rule |
|---|---|
| Weak PINs | Repeated digits, sequences and the end of the phone number are refused. |
| Storage | scrypt with a per-user salt and the server pepper. The PIN itself is never stored. |
| Changing or removing | Needs the current PIN. |
| Lockout | After the configured number of wrong tries (default 5) the PIN locks. Only a normal SMS-code sign-in unlocks it. |
| Error messages | Wrong PIN and unknown number give the same message. |
| Staff accounts | Cannot use PINs; they always use SMS codes. |
| Rate limits | 20 attempts per IP per 10 minutes and 10 per number per 15 minutes. |

**Admin → Settings & roles → PIN sign-in** turns the feature off and sets the attempt limit. Audit events: `auth.pin_set`, `auth.pin_login`, `auth.pin_failed`, `auth.pin_locked`, `auth.pin_removed`.

## 14. Customer data export (super admin)

**Admin → Users** shows the download buttons to a super admin only (permission `customers.export`). There are two exports:
- **Download active customers (CSV):** active customer accounts.
- **All accounts incl. staff:** every account, including staff.

| Topic | Detail |
|---|---|
| Columns | Phone, name, language, joined and last sign-in, available and reserved credits, paid top-ups, credits spent, active and total reminders, groups, WhatsApp opt-in, PIN on/off, referral code, inviter's phone, rewarded referrals |
| Format | UTF-8 with a BOM, so Excel shows Nepali names correctly |
| Formula safety | Cells starting with `= + - @` are prefixed with `'`, so Excel or Sheets never runs them as formulas |
| Limits | 10 downloads per hour |
| Audit | Every download is recorded as `admin.customers_exported`, with the row count |

The file contains personal data: store it securely and delete it when done.

## 15. Web push notifications (free)

Customers turn on notifications in **Settings → Phone notifications**. Each reminder message the dispatcher sends (SMS or WhatsApp) also goes out as a push notification to that customer's devices.

- **Cost.** Push uses no credits.
- **Effect on SMS and WhatsApp.** None. A push failure never stops or changes an SMS or WhatsApp send.
- **Duplicates.** A reminder going by both SMS and WhatsApp produces one push, not two (`push_deliveries`).
- **Keys.** No setup is needed. On first use the app creates a VAPID key pair and stores it in `app_secrets`. That table is server-only and does not appear in Admin settings.
  - To manage the keys yourself, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and optionally `VAPID_SUBJECT` (`mailto:` or `https:`) on the web service.
  - Changing the keys stops every existing device until its customer turns notifications on again.
- **Devices.**
  - Up to 10 devices per customer.
  - A device the push service reports as gone (HTTP 404/410) is removed automatically.
  - The server only posts to the browser push services: Google FCM, Mozilla, Apple and Microsoft.
- **iPhone.** Notifications work only after the customer adds the site to the Home Screen (iOS 16.4 or later) and turns notifications on from inside the installed app.
- **Private windows.** Notifications cannot be turned on in private or incognito windows.

Check how many devices are registered:

```bash
docker exec nabikaran-db-1 psql -U nabikaran -d nabikaran -tAc "select count(*), count(distinct user_id) from push_subscriptions"
```

## 16. Nabikaran Pro and email (Resend)

Admin → **Pro & email** (super admin) is where both are set up.

### 16.1 Email (Resend)

1. In Resend, add the domain `nabikaran.org`. Resend shows SPF and DKIM DNS records: add them in Hostinger DNS and wait until Resend shows the domain as verified. Adding a DMARC record (`_dmarc` TXT `v=DMARC1; p=none; rua=mailto:...`) is recommended.
2. In Resend, create an API key with **Sending access**.
3. Admin → Pro & email:
   - paste the key and press **Save key**;
   - set the From address (for example `reminders@nabikaran.org`, on the verified domain);
   - set an optional Reply-to;
   - tick **Email on** and save.
4. **Send test email** to your own inbox. If it lands in spam, recheck the SPF, DKIM and DMARC records.

How the key is handled:

- It is stored in `app_secrets` on the server. It is never returned to the browser, and the admin page shows only its last 4 characters.
- The audit log records `secret.updated` / `secret.cleared` with the last 4 characters only.
- To rotate it, paste a new key; the old one is replaced. **Remove** turns email off.
- For local development and tests, `EMAIL_PROVIDER=mock` logs emails instead of sending them.

### 16.2 Pro plan

- **Off by default.** Tick **Pro on sale** after email works.
- **Settings:** price (NPR), plan length, trial length, and included SMS / WhatsApp / email per plan. Changes apply to new purchases only.
- **Free trial:**
  - available once per account;
  - gives Pro features only: subscriptions, email sign-in, email reminders paid with credits;
  - includes no messages.
- **Buying:**
  - paid from the wallet (1 credit = NPR 1); customers top up first through the usual QR / Fonepay flow;
  - a purchase is final, with no refund (see the Terms);
  - buying while Pro is active adds another plan period after the current one.
- **Included messages:**
  - used first for any message due before the plan ends;
  - when they run out, or for messages due after the plan ends, wallet credits are used as usual;
  - a failed message gives its included message back, the same way failed messages get their credits back;
  - buying Pro moves already-scheduled messages onto included messages and returns the credits they held.
- **Admin → Users → (customer) → Nabikaran Pro:**
  - **Give Pro** for N days, with or without included messages; a reason is required.
  - **End now** stops a plan. Messages it was funding fall back to credits, and wait for credits if the wallet is short.
  - Both actions are audited.
- **When Pro ends:**
  - data and reminders stay;
  - subscription details stay visible on each reminder;
  - email sign-in stops, but phone OTP and PIN keep working;
  - email reminders fail with "credits returned" if the customer later removes their email.
- **Reports:** Admin → Pro & email shows active paid, trial and given plans, trial-to-paid conversions and sales. The customer CSV export has `email`, `email_verified`, `plan` and `plan_ends_at` columns.

### 16.3 Basic and Pro (what each plan gets)

| | Basic | Pro |
|---|---|---|
| Reminders, groups, AD/BS, Nepali/English, SMS/WhatsApp, wallet credits | ✓ | ✓ |
| Repeat monthly, every 3 or 6 months, yearly, or every N months | ✓ | ✓ |
| Subscription manager (amount, currency, cycle, payment method, auto-renew) | — | ✓ |
| Free-trial tracker and "cancel by" deadline alerts | — | ✓ |
| Insights (monthly/yearly commitments, by payment method, next 90 days) | — | ✓ |
| Renewal history ("Mark as renewed", automatic entries when a subscription renews) | — | ✓ |
| Email reminders, weekly or monthly email summary, email sign-in | — | ✓ |
| Included messages per year (default 100 SMS / 100 WhatsApp / 400 email) | — | ✓ (paid plan) |

Rules enforced on the server:

- Pro screens (`/subscriptions`, `/insights`, `/history`) redirect Basic accounts to `/pro`. Pro APIs answer `403 pro_required`.
- Membership, included messages and wallet credits are kept separate. The Pro page and the sidebar show both included messages and credits, and every preview shows which messages are "Included".
- **Credits after included messages run out need permission.**
  - When the customer saves a reminder, they tick a checkbox to allow it (API code `credits_permission_required`).
  - Background re-planning (yearly or monthly roll-over) does not use credits silently. The messages wait, and the dashboard shows "Messages waiting for your OK" with an **Allow credits** button.
  - A customer can allow this in advance in **Pro → Pro settings**.
- **When Pro expires:** records and credits stay, nothing is deleted, and messages use credits as before.
  - Notices go out by email and push 14 and 3 days before a paid plan ends, and 2 days before a trial ends. They are not sent when another year is already bought.
  - The dashboard shows a notice in the last 30 days.
- **Wording:** messages never claim that Nabikaran cancels anything, detects usage or saves money. "Cancel by" messages remind the customer to cancel themselves, and insights use only figures the customer entered.
- **"Cancel by" reminder:** it is a normal reminder linked to its subscription. It moves, pauses and stops with the subscription, and uses SMS or email (WhatsApp templates are renewal-only).

Not built yet: screenshot-to-reminder (planned after cost and accuracy tests), family sharing, Google Calendar, escalation, price-change history.

## 17. Integrations: provider keys in the admin panel

**Admin → Integrations** (super admin) holds the keys and modes for these providers:

- **Aakash SMS:** auth token.
- **Khalti:** secret key, and live or test environment.
- **Fonepay dynamic QR:** mode, merchant code, username, password and HMAC secret key.
- **WhatsApp (Meta Cloud API):** access token, app secret and webhook verify token.
- **Resend:** API key. The From address and test send stay in **Pro & email**.

How keys are handled:

- **Write-only.** A pasted key is never shown or returned again. The page shows only its last 4 characters and where it comes from: "Saved here", "From server .env" or "Not set".
- **Encrypted at rest** in `app_secrets` with AES-256-GCM. The encryption key comes from `SECRETS_KEY` if set, otherwise `SESSION_SECRET`. If that server key changes, saved keys show "cannot be read: paste it again".
- **Panel wins over `.env`.** A key or mode saved here is used instead of the server `.env` value. **Remove** a key, or choose "Use server .env", to go back to the server value. Existing `.env` setups keep working with no change.
- **No restart.** Changes apply within seconds: providers rebuild and the values are refreshed every 30 seconds.
- **Production guard.** "Mock" providers are rejected in production.
- **Audit.** Every key change is logged as `secret.updated` / `secret.cleared` with the last 4 characters only, and every test as `integration.tested`.

Checks on the page:

- **Send test SMS to me** sends one real SMS to the admin's own number.
- **Check key** for Khalti makes a harmless lookup; a wrong key answers 401.
- **Check connection** for WhatsApp reads the phone number from Meta.
- Fonepay has no harmless test call. Check it with a NPR 10 top-up.

## 18. Calendar sync (Pro) and the installable app (PWA)

### 18.1 Google Calendar, Apple Calendar and Outlook

Pro customers open **Settings → Google Calendar sync → Create my calendar link**. They then have three ways to add it:

- **Add to Google Calendar**, which subscribes the Google account;
- **iPhone / Apple Calendar** (a `webcal://` link);
- **Outlook**.

How it works:

- **The feed.** It is a private, read-only iCalendar feed at `/api/calendar/<token>.ics` (migration `0012_calendar`: `users.calendar_token`). It needs no Google sign-in, no OAuth app and no Google API key. Nabikaran never reads or writes the customer's calendar.
- **What it contains.** One all-day event per active reminder on its Nepal date, with the amount and payment method for subscriptions. Free-trial ends and cancel-by dates are named as such.
  - AD-dated yearly reminders get a yearly repeat rule. AD-dated monthly reminders get a monthly rule, unless they fall on the 29th–31st.
  - BS dates have no rule, because their AD date moves each year. Each next date appears once the reminder rolls over.
- **Refresh.** Calendar apps fetch the feed themselves. Google takes a few hours, so a new reminder is not instant.
- **Security.**
  - The token is the only credential.
  - **Reset link** replaces it, and the old link answers 404 at once. **Turn off** removes it.
  - Feeds are rate-limited per IP.
  - When Pro ends, the link returns an empty calendar, so old events disappear instead of going stale.
- **One-off button.** Each reminder's page has an **Add to Google Calendar** button for a single event (Pro).

### 18.2 PWA

- **Manifest.** It has screenshots (`public/screenshots/`), which Android and desktop Chrome show in a richer install dialog.
  - `launch_handler` reuses an open window.
  - A Dashboard shortcut is included.
  - Retake the screenshots after big UI changes. They must stay 780×1688 (narrow) and 1280×800 (wide).
- **App icon badge.** The installed app's icon shows the number of expired and due-soon reminders, updated each time the dashboard opens. A push notification adds a dot until the app is opened.
- **Service worker** is `nabikaran-v5`. Bump `VERSION` in `public/sw.js` whenever precached files change.

## 19. Coupons, gift cards and the counter

Migration `0013_credit_codes` applies automatically.

**Ground rule:** wallet credits can never be moved from one customer to another. Gift cards are bought with **money**, exactly like a top-up.

### 19.1 Coupon codes (Admin → Coupons & gifts; `coupons.manage`: admin and super admin)

There are two kinds:

- **Single-use codes:** 1–5,000 random codes (`XXXX-XXXX-XXXX`). Each works once, for one customer. Print them on flyers, send one per SMS, or hand them out at events.
- **Shared promo code:** one word such as `DASHAIN50` with a total use limit. Each customer can use it once.

Each batch also has:

- credits per redemption;
- an optional expiry;
- a **CSV download**, which can be downloaded again later.

Codes are stored hashed for lookup and encrypted for the CSV, with the same key as the Integrations secrets.

**Disable** stops all unused codes in a batch at once.

**Cost:** coupons are a marketing cost. The form shows the worst-case credits, and the batch list shows the credits already issued.

**Abuse limits:**

- Customers redeem in **Wallet → Redeem a coupon or gift card**.
- There are 10 attempts per hour per customer and 30 per hour per IP, so codes cannot be guessed.
- Redeemed credits show in the ledger as **Coupon / gift card**.

### 19.2 Gift cards

Customers buy at **/gift**. It is linked from the home page, the dashboard and Wallet.

1. **Pay.** The buyer picks NPR 50–5,000 and pays by QR. With Fonepay dynamic QR the payment is confirmed automatically; otherwise an admin approves it in Top-ups.
2. **Pending until paid.** Until the payment is confirmed, the code exists but cannot be redeemed. A cancelled or rejected payment cancels the code.
3. **Share.** Once paid, the buyer sees the code with Copy, WhatsApp and Share buttons. The share link pre-fills the code in the recipient's Wallet.
4. **Buyer's wallet.** It is never touched. The money bought a code, not credits.
5. **Rules.** Gift cards are non-refundable and do not count towards referral rewards.

Settings (super admin, on the same page): on or off, minimum and maximum NPR.

### 19.3 Counter (`/counter`; `counter.topup`)

Who can use it:

- the new **Counter staff** role (Settings & roles → user → role), for front-desk staff or agents;
- finance, admin and super admin also have it.

Counter staff **cannot open the admin console or any admin API**. They only have /counter.

What staff can do:

- **Top up a customer.** Look up the customer by mobile number, then enter the amount received, how they paid (cash, eSewa, Khalti, Fonepay, bank or other), the receipt number and a note.
  - Confirming credits the wallet immediately as a normal **top-up**, so it counts for referrals and releases held messages.
  - The customer gets a push notification.
- **Sell a gift card** for cash. The printable receipt shows the code, which works immediately.

Safeguards:

- **Idempotent.** A double click records the entry once.
- **Receipt numbers** cannot be reused.
- **No self top-ups.** Staff cannot credit their own wallet.
- **Daily limit.** Staff other than super admins have a daily limit per person: NPR 50,000 by default, set under Coupons & gifts.
- **Audit.** Every entry is audited (`wallet.counter_topup`, `wallet.counter_gift_sold`).

**Cash reconciliation:**

- **Today's list** shows each entry and the totals per payment method for the signed-in staff member.
- **All staff** (for admins) shows the whole desk.
- Count the drawer against the **Cash** total.
- Admin **adjustments** (Users → customer → Adjust credits, with the two-person rule) remain for corrections, not for sales.
