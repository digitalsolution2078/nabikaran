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

- **Top up a customer.** Look up the customer by mobile number, then enter the amount received, how they paid (cash, Khalti, Fonepay, bank or other), the receipt number and a note.
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

## 20. Banning a customer (Admin → Users → customer → Account access)

Who can ban: admin and super admin (`users.ban`). Staff accounts must be changed to Customer first, and nobody can ban themselves. Migration `0014_user_bans` applies automatically.

### 20.1 What a ban does

The account gets status `suspended`, with a required **reason** (internal only, never shown to the customer) and a **duration**: permanent, 7, 30 or 90 days. On ban:

- **Signed out** at once. Sessions need an active account.
- **No sign-in.** No SMS code is sent to a banned number, so it costs nothing. A code sent before the ban stops working. PIN and email sign-in fail too.
- **The customer sees** "This account has been suspended… contact Nabikaran support", followed by `SUPPORT_PHONE` / `SUPPORT_EMAIL`.
- **ChatGPT / Claude** connections are revoked.
- **No messages** are sent: active reminders are paused and their held credits released.
- **Nothing is deleted.** Reminders, wallet balance, ledger, payments, Pro plan and all history stay.

### 20.2 Unban

Unban restores the account and resumes exactly the reminders the ban paused. Reminders the customer had paused themselves stay paused. A reminder the wallet cannot cover stays paused, and the customer can resume it after a top-up. Time-limited bans lift themselves (reconciler, `bansLifted`).

### 20.3 History and audit

Every ban and unban is kept in the customer's **ban history**: who, when, reason, until. It is also in the audit log as `user.banned` / `user.unbanned`.

## 21. Security (pre-launch review, migration `0015_security`)

What is enforced in code:

- **Admin pages.** Every admin page checks the role itself (`requireAdminPage`), not only the admin layout. Counter-only staff never see admin data.
- **Sign-in.**
  - Same-site checks on every sign-in and logout request.
  - Atomic limits: SMS-code requests are capped at 3 per phone per 15 minutes and `OTP_PER_IP_PER_HOUR` (default 40) per IP. The IP limit is generous because mobile carriers share IPs (CGNAT). Code checks are capped at 10 per phone per 15 minutes.
  - The `next=` redirect after sign-in accepts same-site paths only.
- **Rate-limit IP.** It is the address our own proxy saw: the `TRUSTED_PROXY_HOPS`-th entry from the right of X-Forwarded-For (default 1, Traefik). Keep Traefik's `forwardedHeaders.insecure` off. If another proxy (Nginx, Cloudflare) sits in front of Traefik, raise the number.
- **Money.**
  - Staff accounts cannot redeem coupons or gift cards, and an admin cannot redeem a coupon they made.
  - A coupon batch from anyone but a Super Admin can give away at most 10,000 credits in total.
  - One bank or wallet reference can fund only one top-up, however it is typed ("FT 123" = "ft123" = "FONEPAY:123").
  - A Khalti payment reference belongs to one order.
  - The referral cap holds under concurrent top-ups.
  - Nobody can request an adjustment to their own wallet.
- **Errors and health.** Clients never see database or network error text; `/api/health` says only `down`.
- **Headers.** `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'` and `Permissions-Policy` are added to the existing HSTS, X-Frame-Options, nosniff and Referrer-Policy.
- **Uploads.** Receipts over 3.5 MB are refused before they are read.
- **Mock SMS.** On a real domain the mock SMS provider never prints sign-in codes into the logs, and it warns that nothing is delivered.

Owner checklist before launch:

1. **SMS.** `SMS_PROVIDER=aakash` with a valid key (Admin → Integrations). With mock, no one receives sign-in codes.
2. **Secrets.** `SESSION_SECRET`, `OTP_PEPPER`, `WORKER_TOKEN` and `SECRETS_KEY` are long random values, e.g. `openssl rand -base64 48`, never `CHANGE_ME`. Changing `SESSION_SECRET` signs everyone out; changing `OTP_PEPPER` only invalidates codes in flight.
3. **Proxy.** Traefik is the only proxy in front of the app, or `TRUSTED_PROXY_HOPS` is set to match.
4. **Backups.** A daily off-server database backup is in place.
5. **Staff accounts.** Every staff account belongs to a real staff member, and roles are as small as possible (Settings & roles).

Known, accepted for launch (low): sessions are 30-day signed cookies (a ban or role change applies at once, but logging out does not revoke a copied cookie); calendar feed tokens are stored as-is (192-bit random); OAuth authorize errors before sign-in can redirect to a registered client URI.

## 22. Authenticator app: two-step sign-in (migration `0016_totp`)

Two-step sign-in is optional for every account and strongly recommended for every staff account. Customers turn it on in **Settings → Authenticator app**:

1. Scan the QR code with Google Authenticator, Microsoft Authenticator or Authy.
2. Enter the 6-digit code from the app.
3. Save the 10 one-time recovery codes; they are shown only once.

From then on, every sign-in (SMS code, PIN or email) needs one more step before a session exists: an app code or one recovery code. The same applies to sign-ins started from ChatGPT or Claude, because they use the same sign-in page.

- **Standard and storage.** Codes follow TOTP (RFC 6238: SHA-1, 30 s, 6 digits), with ±30 s for clock drift. Each code works once. The secret is encrypted with the server key, like provider keys. Recovery codes are stored hashed.
- **Limits.** 8 code attempts per account per 15 minutes. The waiting step expires after 10 minutes.
- **Managing it.**
  - Turning it off needs an app code or a recovery code.
  - New recovery codes need an app code, and the old ones stop working.
- **Lost phone and lost recovery codes.** A Super Admin uses **Admin → Users → customer → Two-step sign-in → Reset 2FA**, with a reason, after checking the customer's identity (for example, a call from their registered number). This is logged as `auth.2fa_reset_by_admin`.

### 22.1 Compulsory for staff

Every staff role (super admin, admin, finance, support, content, auditor, counter) must turn on the authenticator app. Until they do:

- **Pages:** `/admin` and `/counter` redirect to **Settings → Authenticator app**, which shows a red notice at the top.
- **APIs:** every staff API answers `403 staff_2fa_required`.

Customers are not forced; for them the app stays optional.

**Emergency switch.** Set `STAFF_2FA_REQUIRED=false` in `.env` and restart the app. Use it only if every super admin has lost both their phone and their recovery codes. Turn it back on as soon as access is restored.

## 23. Free app notifications, support tickets, decimal credits and top-up bonus (migrations `0017`–`0020`)

**Free app (push) reminders (`0017_push_channel`).** "App notification only" is a delivery channel on every plan. Push jobs cost nothing, need no reservation and are never blocked by a low or negative balance. The dispatcher marks them `delivered` when the customer has at least one device with notifications on, `failed` otherwise (the preview warns about this). Paid SMS/WhatsApp/email reminders still send a free push alongside, as before.

**AI apps (MCP).** Admin → AI apps (MCP) lists every customer connected through ChatGPT/Claude (name, phone, app, access, last used). Staff with `oauth.manage` can disconnect one customer from one app; the customer can reconnect. The same list appears on each customer's page.

**Support tickets (`0018_support`).** Customers open tickets at `/support` (signed in: linked to the account; visitors: name + phone or email, and a private link whose hash only is stored). Staff with `support.manage` (support, finance, admin, super admin) work them in Admin → Support: reply, internal note, status, priority, assign. A reply notifies the customer by free app notification and/or email. Payment tickets start as high priority. Attachments: PNG/JPG/WebP/PDF up to 3 MB, content-checked.

**Decimal credits (`0019_decimal_credits`).** 1 credit is still NPR 1, but every credit amount is now `numeric(14,2)` — exact two-decimal maths in Postgres. Default prices per message: SMS 1.50, WhatsApp 1.00, email 0.30; app notifications free. Change them in Admin → Channels & pricing (two decimals at most; applies to new schedules only, booked messages keep their price). "Top up at least…" amounts round up to whole rupees.

**Top-up bonus (`0020_topup_bonus`).** Tiers (default NPR 500+ 3%, 1,000+ 5%, 2,500+ 8%, 5,000+ 10%) are edited in Admin → Channels & pricing. The bonus is fixed when the top-up request or payment order is created, applies to QR, gateway and counter wallet top-ups (not gift cards or coupons), and is posted as a separate `bonus` ledger line. A refunded gateway payment reverses the top-up and its bonus together. Remove every tier to switch the bonus off.

**eSewa removed (`0025_remove_esewa`).** eSewa is no longer a payment method anywhere (wallet, counter, admin). The migration deletes its stored secret key and settings and cancels eSewa orders that never completed; paid eSewa history stays in the ledger and reports. `ESEWA_*` lines in the server `.env` are ignored and can be deleted.

**Pro monthly credits (`0021_pro_monthly_credits`).** Pro now gives flexible credits instead of fixed SMS/WhatsApp/email counts: 30 credits every plan month by default (Admin → Pro & email → "Credits every plan month"; 30 credits ≈ 20 SMS, 30 WhatsApp or 100 emails). The amount is fixed per plan when it is bought (`user_plans.monthly_credits`). The reconciler gives each active paid/granted plan its month's credits (`pro_credit` ledger line) and, when a plan month ends, takes back what was not spent on messages (`pro_expiry`) — never more than the free balance, so paid top-ups and credits held for scheduled messages are safe. Trials give Pro features only. Plans bought before this change keep their included messages. The migration switches the saved Pro offer to 30 credits/month with 0 included messages.

## 24. Revenue dashboard and "log out all devices" (migration `0022`)

**Admin → Revenue** (`revenue.view`: finance, admin, super admin, auditor). For a preset or custom range (Nepal days): money in (QR, Fonepay, counter by method, Khalti, gift-card sales, minus refunds), money in per day, payment-method split, messages and credits used per channel, promotions given (top-up bonus, referrals, coupons, Pro monthly credits net of expiry, adjustments), sign-in fees, Pro sold/trials/paying, new and paying customers, and the credits customers hold (prepaid liability). "Download CSV" exports the same range.

**Log out all devices.** Customers: Settings → Signed-in devices → "Log out all other devices" (this device stays signed in). Admins with `users.ban`: customer page → Account access → "Log out all devices". Sessions issued before `users.sessions_valid_after` are refused.

## 25. Low-credit alerts

Every message is funded when it is saved, so a reminder shows **Waiting for credits** only when its next cycle (yearly or repeating reminders, re-planned dates) could not be funded. Without a top-up it will not be sent. The reconciler tells the customer, keyed on the earliest waiting message:

| Step | When | Channels |
|---|---|---|
| New | first noticed | app notification + email (if verified) |
| Soon | 7 days before it is due | app notification + email |
| Last call | `last_call_days` (default 2) before it is due | app notification + email + one SMS (if on) |

- Each step goes once per waiting message, at most one alert per customer per 20 hours, 8 am–8 pm Nepal time.
- The message names the credits needed, the credits free and a top-up amount (the shortfall, at least the minimum top-up) with a `/wallet?amount=` link.
- Messages waiting for Pro permission ("use wallet credits") are not included.
- The dashboard shows the same banner with a **Top up NPR X** button.
- Settings: Admin → Settings → **Low-credit alerts** (on/off, last-call SMS, last-call days). The SMS is free for the customer and costs the business one SMS.
- Each alert is in the audit log as `low_credit.alert` (stage, amount, channels used). Admin home → Low balance shows the last alert per customer.

## 26. Checkout by Fonepay (migration `0023`)

Fonepay is an online payment method next to Khalti. The customer picks **Fonepay** on the wallet page, pays on Fonepay's checkout page (QR or mobile banking) and is sent back to `/api/payments/fonepay/return`.

- **Setup:** Admin → Integrations → **Checkout by Fonepay**. Enter the merchant code (PID) and the secret key, choose **test** (Fonepay dev server) and make a test payment, then switch to **live**. Give Fonepay the return URL `https://nabikaran.org/api/payments/fonepay/return`.
- **Request:** `GET clientapi.fonepay.com/api/merchantRequest` with PID, MD=P, PRN (our order reference), AMT, CRN=NPR, DT (MM/DD/YYYY), R1, R2, RU and `DV = HMAC-SHA512(secret, "PID,MD,PRN,AMT,CRN,DT,R1,R2,RU")`.
- **Crediting:** the return redirect is untrusted. We take its PRN and UID and call `…/merchantRequest/verificationMerchant` (`DV = HMAC-SHA512(secret, "PID,AMT,PRN,BID,UID")`). Credits are added only when Fonepay answers success for our PRN and amount, exactly once.
  - The UID is saved with the order, so if Fonepay was unreachable at return time, the reconciler finishes the payment later.
  - A customer who closes the browser before returning has no UID. That order stays pending; if they paid, credit it from Fonepay's merchant portal with an admin adjustment.
- **Return signature:** the return's own `DV` is checked and a mismatch is logged, but crediting depends only on the verification call.
- **Older dynamic-QR API:** used only when its API username and password are also set. Checkout-only merchants leave them empty and keep the static QR as a fallback.
- **Env fallback:** `FONEPAY_MODE=test|live`, `FONEPAY_MERCHANT_CODE`, `FONEPAY_SECRET_KEY`, optional `FONEPAY_CHECKOUT_BASE`.

## 27. First-reminder nudges (migration `0023`)

People who signed up but never added a reminder get, by account age:

| Step | Default day | Channels |
|---|---|---|
| First | 1 | app notification + email (free) |
| SMS | 3 | one SMS with `nabikaran.org/renewals/new` (costs one SMS) |
| Last | 10 | app notification + email (free) |

- Each step goes once per person, at most one nudge a day, 10 am–7 pm Nepal time.
- Nudges go only to accounts younger than the window (30 days), so older accounts are never messaged.
- Adding a free app reminder needs no credits, so the nudge never asks anyone to pay first.
- Customers can turn the tips off in Settings; the switch is shown until they add a reminder (`users.nudges_opt_out`).
- **Settings:** Admin → Settings → **First-reminder nudges** (days, SMS on/off, SMS text up to 160 characters with `{link}`, window). The same card shows people nudged, how many then added a reminder, and the SMS sent in the last 30 days.
- Each nudge is in the audit log as `nudge.sent` (stage, channels).

## 28. Business accounts: reminders for clients (migration `0024`)

Built for dealers, insurance agents and consultancies that track renewals (bluebook, insurance, licence, company and tax renewals) for their own clients.

- **Turn on:** Settings → **Business tools**. The business name (2–20 English characters) is shown in every client SMS. Once on, **Clients** appears in the menu.
- **Clients:** `/clients` lets the business add (name, mobile, note), search, edit and archive clients. Adding a client requires a tick that the client agreed to receive reminder SMS. A client with active reminders cannot be archived.
- **Reminders:** the add/edit form has "Who is this reminder for?" (Me / a client).
  - A client reminder goes **by SMS to the client's phone**, with the business name after the label. The SMS still fits one message: the label is shortened first if needed.
  - The business pays from its wallet at normal SMS prices.
  - The business gets a free app-notification copy ("Sent to Hari: …").
  - WhatsApp and email are not used for clients, because they need the recipient's own opt-in.
- **List and filter:** the reminders list shows the client name and filters with `?client=`.
- **Import:** Excel / CSV import accepts `client` and `client phone` columns. Clients are created or reused by number. A tick that the clients agreed is required. A bad number is a row error; without business tools, client rows are flagged.
- **Complaints:** Admin → Settings → **Business accounts** → *Block number*. That number's pending client reminders are cancelled (credits go back to the business), and no business can add it again. Use *Unblock* to reverse it.
- **Admin settings:** business accounts on/off and the most clients per account (default 1000). The card shows the number of business accounts, clients and active client reminders. The admin user page shows each account's business name and counts.
- **Audit log:** `business.enabled` / `business.disabled`, `client.create` / `client.update` / `client.archive`, `recipient.block` / `recipient.unblock`.
- **Data export:** includes the account's clients.

## 29. My records: record limits, record-only items, overview

- **Menu:** "Reminders" is now **My records** (मेरा रेकर्ड). Every record has an expiry status, and its reminders can be on or off.
- **Record only:** in the add/edit form, "Remind me about this" can be switched off. The record and its date are kept with no messages, no credits and no reservation; past dates are allowed (e.g. an expired licence). Switching reminders on later is a normal edit.
  - A zero-cost save is never blocked, even when the sign-in fee left the wallet at −1.
- **Overview** (top of `/renewals`):
  - usage `used / limit`;
  - counts for valid, expiring in 30 days, expired and record only; each one is a filter (`?filter=…`, `?remind=off`);
  - type chips (`?cat=vehicle|personal|insurance|business|occasions|custom`);
  - a Spending link for Pro.
- **Record limits** (Admin → Settings → **Record limits**): Free 150, Pro 10,000 by default.
  - Active and paused records count; deleted ones and the automatic "cancel by" companions do not.
  - Enforced for the web form, Excel/CSV import (checked before anything is saved, with the room left shown in the preview), confirmed AI-assistant actions and MCP `prepare_reminder`.
  - Over the limit, nothing is removed; adding stops with `record_limit` (403), and Free accounts get a link to Pro.
  - The admin card shows Free accounts at or near the limit: good people to offer Pro.
- **Pricing page:** shows both limits.
