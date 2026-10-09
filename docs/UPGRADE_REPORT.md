# Nabikaran production upgrade — report

Branch `claude/bold-brahmagupta-zglkbf`. Migrations `0005` and `0006` are additive; no table is reset.

## Changed files (by area)

| Area | Main files |
|---|---|
| Database | `supabase/migrations/0005_signin_fee_dynamic_qr.sql`, `0006_channels_roles_ops.sql` |
| Channels / WhatsApp | `src/lib/whatsapp/*`, `src/lib/providers/whatsapp/*`, `src/app/api/webhooks/whatsapp/route.ts`, `src/lib/services/billing.ts` |
| Reminder core | `src/lib/core/reminders.ts`, `prepared-actions.ts`, `account-lock.ts`, `dto.ts`, `wallet.ts` |
| Dispatcher / reconciler | `src/lib/services/dispatcher.ts`, `src/lib/providers/sms/aakash.ts`, `mock.ts` |
| Customer UI | `src/app/dashboard`, `renewals` (list, detail, new, edit), `messages`, `wallet` (history, receipt, topup), `settings`, `error.tsx`, `components/RenewalForm.tsx` |
| Admin | `src/app/admin` (overview, messages, sms → Channels & pricing, users/[id], wallet/topups, templates), `src/lib/services/ops.ts`, `admin-console.ts`, `whatsapp-admin.ts`, `src/lib/auth/rbac.ts` |
| Wallet / finance | `src/lib/services/wallet-report.ts`, `manual-topups.ts`, `providers/payments/fonepay.ts` |
| Legal / SEO | `src/app/privacy`, `terms`, `renewal-reminder/*`, `sitemap.ts`, `robots.ts`, `src/lib/seo-pages.ts` |
| Security | `src/lib/http.ts` (`limit`), rate limits on OTP, top-ups, reminders, admin and webhook routes |
| Docs | `docs/OPERATIONS.md`, `docs/ADMIN_AND_PAYMENTS.md`, this report |

## Bugs fixed

1. **Dashboard:** rebuilt on a single summary service that returns strings only; each section fails soft and logs `[dashboard] … user <id>`. An app-wide error page shows an Error ID.
2. **Price changes re-priced scheduled SMS:** charges now use the price booked at reservation.
3. **Provider unit counts billed instead of the quote:** customers pay exactly the preview.
4. **Shortfall ignored negative balances:** a -1 balance with 12 credits needed now asks for 13.
5. **Reminders over two years ahead were not funded:** now reserved immediately.
6. **"1 days before" / "1 days left":** singular-aware everywhere.
7. **Nepali digits shown as Latin in stat cards:** a font tabular feature was swapping them.
8. **Any staff role could request or approve credit adjustments:** now permission-checked.
9. **Single admin could not process their own top-up:** a warning now tells you to add another reviewer (the self-approval ban stays).
10. **Mock SMS counted GSM text as Unicode:** fixed, so tests reflect real billing.

## New features

- **Customer:** dashboard cards (expired, due soon, scheduled, awaiting credits, wallet, next reminder) and quick actions; renewals filters and search; lifecycle detail with channel and sent history; Messages page; SMS / WhatsApp / both picker with consent, previews and combined cost; BS confirmation; Edit page.
- **WhatsApp:** Meta Cloud API with approved templates, separate credit price and history, signed webhook (sent / delivered / read / failed), automatic refund on failure, STOP opt-out, admin settings without secrets, template mapping, health and audit events.
- **Wallet:** finance-grade statement (purchased, spent on SMS, spent on WhatsApp, refunded, reversed, fees, adjustments), Khalti vs QR clearly separated, printable receipts, Fonepay dynamic QR when credentials exist.
- **Admin:** operations dashboard; six roles; Channels & pricing; message log and queue by channel; user 360 with notes and audit history; template versions, publish flag, channel defaults and customer preview.
- **Trust:** final Privacy and Terms (reminders only, no government database, no delivery guarantee); closure shows and records the remaining balance.
- **Growth:** eight SEO landing pages with FAQ schema, sitemap and robots; homepage tagline "Nepal ko personal renewal command center."
- **MCP:** channel-aware prepare/confirm; the prompt includes message text, channel, AD/BS date, schedule and cost; assistants cannot give WhatsApp consent, top up, or address another number.

## Verification

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | clean |
| Unit + integration (Vitest, real migrations on PGlite) | 179 / 179 across 16 files |
| Migrations on PostgreSQL 16 via the production `migrate.sh` | 0001–0006 applied cleanly |
| Production build (`next build`) | clean |
| Browser end-to-end on PostgreSQL 16 (mobile + desktop) | 39 / 39 |
| HTTP checks | SEO pages 200, unknown slug 404, sitemap 12 URLs, no draft text, webhook unsigned 401, bad verify token 403, admin API anonymous 401 |

There is no linter in this repository; adding ESLint would be a new dependency, so strict typechecking stands in.

## Remaining production risks

1. **Production dashboard error not reproduced.** It did not occur on PostgreSQL 16 with merged or new code. The new dashboard cannot crash the page, but please send the log line (command in `docs/OPERATIONS.md` §7) so the root cause is confirmed.
2. **Live providers untested:** Aakash delivery reports, Meta WhatsApp, Fonepay dynamic QR and Khalti. All are covered by mocks and contract tests only.
3. **Aakash report API shape is unverified**, which likely explains "delivered = 0". Confirm it with Aakash.
4. **WhatsApp templates must be approved by Meta**, and the WhatsApp credit price set from your rate card, before enabling.
5. **Business decisions to confirm:** the no-refund-at-closure policy, the sign-in fee and the −5 floor. Also set `LEGAL_ENTITY_NAME`, address and support contacts; a lawyer's review of Privacy and Terms is still advisable.
6. **Colour palette:** web.digitalsolutionnepal.com was unreachable from the build environment.

## Deployment

Production (`/docker/nabikaran`) deploys automatically when CI passes on `main`; see `docs/DEPLOY_VPS.md` §3. Manual equivalent on the server:

```bash
# 1. add new variables to the stack's environment first (see .env.production.example): WHATSAPP_*, LEGAL_*, SUPPORT_*, FONEPAY_*
bash /root/nabikaran-deploy.sh                       # backup → recreate web from latest main → health check
docker exec nabikaran-db-1 psql -U nabikaran -d nabikaran -c "select * from _schema_migrations order by 1"   # 0005, 0006 present
curl -s https://nabikaran.org/api/health
```

After deploy: promote a second person to Finance reviewer, set the sign-in fee/floor (Admin → Settings & roles), and leave WhatsApp disabled until the Meta setup in `docs/OPERATIONS.md` §2 is done.
