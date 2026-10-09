# Nabikaran — SMS renewal reminders for Nepal

Nepal-first web app: save expiry dates (AD or Bikram Sambat), buy prepaid SMS credits (1 credit = NPR 1, never expire), and get Nepali-language SMS reminders on your verified +977 mobile. Implements PRD v1.0 (09 Oct 2026).

## Stack

- Next.js 16 (App Router, PWA) · TypeScript · React 19
- PostgreSQL (Supabase) — all money/dispatch invariants live in SQL functions (`supabase/migrations/0001_init.sql`)
- Aakash SMS (provider adapter, replaceable) · Khalti KPG-2 (eSewa phase 2)
- Vitest + PGlite: tests run the real migration in-process, no DB server needed

## Run locally

```bash
cp .env.example .env.local      # set DATABASE_URL (any Postgres 14+), secrets
psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
npm install
npm run dev                     # http://localhost:3000
```

In development `SMS_PROVIDER=mock` logs OTP codes to the console (and the login page shows them); `PAYMENT_GATEWAY=mock` opens `/pay/mock` where you choose the payment outcome, including a tampered-amount case.

Workers (production: Vercel Cron per `vercel.json`, bearer `CRON_SECRET` = `WORKER_TOKEN`):

```bash
curl -X POST -H "Authorization: Bearer $WORKER_TOKEN" $APP_URL/api/jobs/dispatch    # every minute
curl -X POST -H "Authorization: Bearer $WORKER_TOKEN" $APP_URL/api/jobs/reconcile   # every 5 minutes
```

Make a user admin: `update users set role = 'admin' where phone_e164 = '+977...'`.

## Tests

```bash
npm test          # 46 tests: phone/BS/time/segments/scheduler + wallet SQL + dispatcher/payments/OTP flows
npm run typecheck
```

Covered scenarios (PRD §13): double/concurrent payment callback, tampered amount, cancelled checkout, forged pidx; two workers claiming the same job; crash after provider accepted (stale lease → unknown, reconciled, charged once); insufficient balance → awaiting credits → auto-schedule after top-up; edit cancels old cycle and releases holds; BS day-33 rejection; Unicode multi-segment billing; OTP attempts and rate limits; unverified destination never messaged.

## Money model (PRD §4)

| Rule | Where enforced |
| --- | --- |
| No negative balance, reserved ≤ posted | `wallets` CHECK constraints |
| Ledger append-only, idempotent | trigger + `idempotency_key UNIQUE` |
| Top-up credited exactly once, only after server lookup says Completed + amount matches | `wallet_apply_topup`, `confirmPaymentByRef` |
| Reserve ≠ charge; charge actual units once at accept; release remainder | `wallet_reserve_for_job`, `wallet_commit_for_job` |
| Provider rejection → release/reverse; unknown → reconcile, never resend | `runDispatcher`, `runReconciler` |
| Admin adjustments need two different admins | `wallet_adjustment_requests` CHECK + `wallet_apply_adjustment` |
| No TTL/expiry/forfeiture of credits | there is no such job anywhere |

## Layout

```
supabase/migrations/   schema, SQL functions, RLS
src/lib/               phone, time (NPT), bs-date, scheduler, sms/segments+templates, env, db
src/lib/providers/sms  SmsProvider contract: aakash, mock
src/lib/payments       PaymentGateway contract: khalti, mock
src/lib/auth           OTP (hashed, rate-limited), JWT cookie sessions, CSRF origin check
src/lib/services       renewals, wallet, payments, dispatcher/reconciler, admin
src/app/api            routes per PRD §10 (+ /api/me export/close, /api/admin/*)
src/app                pages: / login onboarding dashboard renewals(+new,[id]) wallet(+history) settings privacy terms admin
tests/                 vitest (PGlite)
docs/                  architecture notes
```

## Before launch (PRD §14)

Register domain and legal entity; Aakash written quote (Unicode billing, OTP, sender ID, report semantics) and verify adapter field names against the sandbox; Khalti production merchant approval; finalise privacy/terms/refund/closure policy; independent review of reconciliation and duplicate-charge tests.
