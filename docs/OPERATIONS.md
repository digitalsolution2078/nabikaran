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
