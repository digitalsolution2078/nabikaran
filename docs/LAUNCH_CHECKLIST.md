# Nabikaran — Staging & Launch Checklist (web + MCP)

Everything below is operational; the code on `claude/bold-brahmagupta-zglkbf` is complete through Phase 4. Each step names who approves it.

## A. Private staging (current path: VPS / Docker)

Follow [STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md). Vercel/Supabase is an
alternative requiring a separately verified account, plan, DB and cron setup;
it is not evidence of the installed deployment. Apply **all** migrations,
currently `0001` through `0006`, rather than the old `0001..0003` subset.

- [ ] Confirm host ownership, installed deploy script, capacity and proxy.
- [ ] Start the standalone staging Compose project with independent secrets/DB.
- [ ] Check forced SMS/payment mocks, WhatsApp off and real manual QR disabled.
- [ ] Confirm authoritative NS, snapshot records, add only staging records.
- [ ] Configure restricted HTTPS proxy for both staging hosts.
- [ ] Verify DB + worker health and OAuth discovery; test account isolation.
- [ ] Use synthetic accounts only; production-mode OTP is in restricted app logs,
      never returned to the browser. Disable indexing; restrict tester access.

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
- [ ] Secrets only in protected runtime env / secrets vault; none in the repo (`git grep -i "secret\|token" -- ':!*.md' ':!tests'` reviewed).
- [ ] `TOKEN_CACHE_SECONDS` ≤ 60 accepted as the maximum revocation delay across instances (same-instance revocations are immediate).
- [ ] Privacy and Terms updated for connected apps reviewed by counsel.
- [ ] Backup + restore drill on the staging database.

## E. Production (needs approval: founder)

| # | Step |
| --- | --- |
| E1 | Production PostgreSQL: apply every approved migration; backup and restore verified. |
| E2 | Production env: `SMS_PROVIDER=aakash` + `AAKASH_AUTH_TOKEN` (after written quote, sender ID and Unicode billing confirmed), `PAYMENT_GATEWAY=khalti` + live key, `KHALTI_BASE_URL=https://a.khalti.com`, `OAUTH_ISSUER=https://nabikaran.org`, `MCP_HOST=mcp.nabikaran.org`, `MCP_PUBLIC_URL=https://mcp.nabikaran.org/mcp`. |
| E3 | DNS `nabikaran.org`, `mcp.nabikaran.org`. Re-run section B against production with a founder phone. |
| E4 | Uptime monitor on `GET /api/health` (alert on 503 ≥ 3 min). Alert on admin "tool error rate > 20%". |
| E5 | Private beta: 50–100 users (PRD §12 Phase 5). Daily reconciliation per PRD §9. |
| E6 | Directory submission: Claude connectors directory and ChatGPT apps once the beta exit gate passes. |

## F. Go / no-go gate

- All automated tests green on the release commit (`npm test`, `npm run typecheck`, `npm run build`).
- Sections B and C recorded on staging with no deviations.
- Section D signed.
- Aakash + Khalti production approvals in hand (PRD §14).
