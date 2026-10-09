# Nabikaran — Staging & Launch Checklist (web + MCP)

Everything below is operational; the code on `claude/bold-brahmagupta-zglkbf` is complete through Phase 4. Each step names who approves it.

## A. Staging environment (needs approval: infra)

| # | Step | Verify |
| --- | --- | --- |
| A1 | Create Supabase project (staging). Apply `supabase/migrations/0001..0003` in order. | `select count(*) from pricing_versions` = 1; `\df wallet_*` lists 7 functions |
| A2 | Deploy the repo to Vercel (staging project). Set env from `.env.example`: `APP_URL=https://staging.nabikaran.org`, `OAUTH_ISSUER` = same, `MCP_HOST=mcp-staging.nabikaran.org`, `MCP_PUBLIC_URL=https://mcp-staging.nabikaran.org/mcp`, `SESSION_SECRET`/`OTP_PEPPER`/`WORKER_TOKEN` (`openssl rand -hex 32`), `CRON_SECRET` = `WORKER_TOKEN`, `SMS_PROVIDER=mock`, `PAYMENT_GATEWAY=mock`, `TOKEN_CACHE_SECONDS=30`. | `GET /api/health` → 200 after the first cron run |
| A3 | DNS: `staging.nabikaran.org` and `mcp-staging.nabikaran.org` → the staging deployment; add both domains to the Vercel project. | `curl https://mcp-staging.nabikaran.org/.well-known/oauth-protected-resource` returns `resource` = `MCP_PUBLIC_URL` |
| A4 | Vercel Cron active (`vercel.json`): dispatch every minute, reconcile every 5. | Admin page shows no "scheduler health" notice |
| A5 | Promote one test account to admin: `update users set role='admin' where phone_e164='+977…'`. | `/admin` renders MCP section |

## B. MCP protocol smoke test (no AI) — run after A

1. `npx @modelcontextprotocol/inspector` → Streamable HTTP → `https://mcp-staging.nabikaran.org/mcp` → Connect.
2. Expect: 401 → discovery → dynamic registration → browser opens `/oauth/authorize` → phone OTP → consent page lists 4 permissions and the masked phone → redirect → tools list shows **7 tools**.
3. Call `get_credit_balance` (0 credits), `list_reminders` (empty).
4. Settings → Connected apps shows "MCP Inspector"; Disconnect → next Inspector call fails with 401.

## C. Assistant conversation matrix — record transcripts as evidence

| # | Prompt | Expected tool path / outcome |
| --- | --- | --- |
| C1 | "What's my Nabikaran balance?" | `get_credit_balance`; shows top-up URL; nothing reserved |
| C2 | "Remind me 7 days and 1 day before my Bluebook expires on 2082-03-15 BS" | `prepare_reminder` → `requires_user_confirmation: true`; assistant shows AD + BS; user agrees → `prepare_reminder` (`user_confirmed: true`) → `confirm_reminder` (`expected_expiry_ad` set) → `funding.status: awaiting_credits` with shortfall (0 credits) |
| C3 | Top up NPR 50 on the website (mock gateway: "Pay (Completed)") | Wallet 50; within 5 min reconcile → `list_reminders` shows jobs `scheduled` |
| C4 | Re-send the same confirm (simulate retry) | `replayed: true`, still one reminder, holds unchanged |
| C5 | "Change it to 3 days before only" | `prepare_reminder` with `reminder_id` → `confirm_reminder`; `cycle_no` 2; holds adjusted |
| C6 | "Pause it" / "Resume it" | `update_reminder`; reserved credits go to 0 and back |
| C7 | "Cancel it" | assistant asks; `cancel_reminder` with `confirm: true`; holds released |
| C8 | Second account connects; asks to list reminders | sees only its own (empty) |
| C9 | Admin disables the client in `/admin` | assistant's next call → 401; Settings shows nothing; re-enable restores |
| C10 | Paste a document photo and ask to set a reminder | assistant extracts fields, calls `prepare_reminder` with `source: extracted_from_image`; must show the date for confirmation; no image bytes sent |

Negative checks: forged bearer → 401 with `WWW-Authenticate`; 61 calls/min → `rate_limited`; `confirm_reminder` with wrong `expected_expiry_ad` → `expiry_mismatch`; prepared id older than 15 min → `prepared_expired`.

## D. Security review sign-off (needs approval: founder + reviewer)

- [ ] `docs/MCP_ARCHITECTURE.md` §7 controls walked through against the code (`src/lib/oauth`, `src/lib/mcp`, `tests/boundary.test.ts`).
- [ ] Secrets only in Vercel env / Supabase vault; none in the repo (`git grep -i "secret\|token" -- ':!*.md' ':!tests'` reviewed).
- [ ] `TOKEN_CACHE_SECONDS` ≤ 60 accepted as the maximum revocation delay across instances (same-instance revocations are immediate).
- [ ] Privacy and Terms updated for connected apps reviewed by counsel.
- [ ] Backup + restore drill on the staging database.

## E. Production (needs approval: founder)

| # | Step |
| --- | --- |
| E1 | Production Supabase: apply `0001..0003`; daily backups on. |
| E2 | Production env: `SMS_PROVIDER=aakash` + `AAKASH_AUTH_TOKEN` (after written quote, sender ID and Unicode billing confirmed), `PAYMENT_GATEWAY=khalti` + live key, `KHALTI_BASE_URL=https://a.khalti.com`, `OAUTH_ISSUER=https://nabikaran.org`, `MCP_HOST=mcp.nabikaran.org`, `MCP_PUBLIC_URL=https://mcp.nabikaran.org/mcp`. |
| E3 | DNS `nabikaran.org`, `mcp.nabikaran.org`. Re-run section B against production with a founder phone. |
| E4 | Uptime monitor on `GET /api/health` (alert on 503 ≥ 3 min). Alert on admin "tool error rate > 20%". |
| E5 | Private beta: 50–100 users (PRD §12 Phase 5). Daily reconciliation per PRD §9. |
| E6 | Directory submission: Claude connectors directory and ChatGPT apps once the beta exit gate passes. |

## F. Go / no-go gate

- 95/95 automated tests green on the release commit (`npm test`, `npm run typecheck`, `npm run build`).
- Sections B and C recorded on staging with no deviations.
- Section D signed.
- Aakash + Khalti production approvals in hand (PRD §14).
