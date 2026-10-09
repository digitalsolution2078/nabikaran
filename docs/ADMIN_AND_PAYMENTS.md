# Admin access, wallet and QR payments — owner runbook

## 1. Roles

| Role | Can do | Cannot do |
|---|---|---|
| `user` | Own reminders, wallet, top-ups, settings | Anything under `/admin` (pages redirect, APIs return 403) |
| `admin` | View admin console; approve/reject QR top-ups; request credit adjustments; approve another admin's adjustment request; manage document templates; manage OAuth clients | Direct credit adjustments, SMS pricing/templates, settings, roles |
| `super_admin` | Everything an admin can, plus direct credit/debit adjustments, SMS templates & credits-per-SMS, top-up limits & QR settings, promoting/demoting admins | Self-promotion, changing own role, adjusting own wallet, approving own top-up, removing the last super admin |

Every rule is enforced in the server (route guards in `src/lib/http.ts`, permission matrix in `src/lib/auth/rbac.ts`) and, for money, again in SQL functions. Hiding a button is never the only protection.

## 2. Becoming the owner (one time)

1. Deploy (see `DEPLOY_VPS.md`) and open `https://<your-domain>/login`. Sign in once with your own phone number and OTP. This creates your verified account.
2. On the VPS, run once:

   ```bash
   cd ~/apps/nabikaran
   docker compose --env-file .env.production exec db psql -U nabikaran -d nabikaran \
     -c "select bootstrap_super_admin('+977XXXXXXXXXX');"
   ```

   It returns your user id. A second call is refused with `super_admin_exists`, so nobody can repeat it later. The call is recorded in the audit log as `rbac.bootstrap_super_admin`.
3. Sign out and sign in again. An **Admin** item appears in the sidebar. Open `/admin`.
4. To add staff: the person signs in once with OTP → **Admin → Users** → search by name, phone or email → open → **Role** → `admin` → confirm.

Shell access to the database server is the root of trust. Keep SSH keys and `.env.production` private.

## 3. Wallet rules

- 1 credit = NPR 1. Credits never expire. Balances can never go negative (SQL `check` constraints plus the `wallet_*` functions).
- Customers top up with a quick amount or any custom amount between the configured minimum and maximum (default NPR 20–10,000; change in **Admin → Settings & roles**).
- Every ledger row has a unique idempotency key. Replaying a payment callback, double-clicking Approve, or two admins approving at once credits exactly once (tested with four concurrent approvals).

## 4. QR top-up flow (manual verification)

Your attached QR is a **static Fonepay merchant QR** (EMVCo, point-of-initiation `11`, merchant `NARIKOT DIGITAL PRIVATE LIMITED`, terminal `2222010021806804`, MCC 7399, NPR). A static QR carries **no amount and no remarks**. The app therefore never edits the payload. It shows your unchanged QR next to the exact amount and a unique payment reference such as `NB7KQ2MX`.

Customer side:

1. Wallet → enter amount → see credits → **Pay via QR**.
2. Scan the QR in any Fonepay-enabled bank/wallet app, pay the exact amount, put the reference in the remarks.
3. Enter the bank transaction ID; optionally attach a receipt (PNG/JPEG/WebP/PDF ≤ 3 MB, type checked by file signature).
4. Status becomes **Waiting for admin verification**. A customer can hold at most 3 open requests.

Admin side (**Admin → Top-ups**, `/admin/wallet/topups`):

1. Open a pending request. Check the amount, reference and receipt.
2. **Find the credit in your own bank or Fonepay merchant statement.** The receipt and the customer's transaction ID are claims, not proof.
3. Enter the **bank statement reference** you found and confirm. That reference can be used for only one approval ever, which stops one payment being claimed twice.
4. Or **Reject** with a reason the customer will see.

Approver, time, bank reference and notes are stored on the request and in the audit log. An admin cannot approve their own top-up.

**Before going live:** confirm that `NARIKOT DIGITAL PRIVATE LIMITED` is your business's account. Until you tick *I verified this merchant account* in **Admin → Settings & roles**, customers see a warning beside the QR.

**Dynamic QR (amount and remarks embedded, auto-confirmation):** possible only through Fonepay's merchant API agreement. When you have it, it plugs into the existing payment gateway layer (`src/lib/services/payments.ts`) like Khalti.

## 5. Manual credit adjustments (independent of top-ups)

- **Super admin:** Admin → Users → user → *Adjust credits*. Signed amount, mandatory reason (≥ 5 characters), confirmation dialog. Debits that would overdraw are refused.
- **Admin:** the same form creates a *request*. A different admin or super admin must approve it. Nobody can approve an adjustment to their own wallet.

## 6. SMS cost controls

- **Admin → SMS & pricing** sets *credits per SMS* (default 3). Each change creates a new pricing version, and existing reservations keep the price they were booked at.
- Your Aakash cost per SMS is a separate business number. It is not hardcoded anywhere. Margin = credits per SMS × NPR 1 − provider cost.
- SMS templates are English or Romanized Nepali only, and are validated to fit one GSM-7 segment (160 characters) in the worst case before they can be saved.

## 7. Audit log

**Admin → Audit log** lists every role change, approval, rejection, adjustment, setting and template change. The database rejects `UPDATE` and `DELETE` on `audit_events`, so not even a super admin can rewrite history through the app.
