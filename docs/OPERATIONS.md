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

After deploying, confirm the migration ran:

```bash
docker exec nabikaran-db-1 psql -U nabikaran -d nabikaran -c "select * from _schema_migrations order by 1 desc limit 3"
docker exec nabikaran-db-1 psql -U nabikaran -d nabikaran -c "\d reminder_groups"
```
