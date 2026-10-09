# Nabikaran — MCP-Ready Architecture Proposal

Status: **approved (all five decisions in §11). Phases 0–1 implemented — see §12–13. No infrastructure is deployed; migration `0002` is additive and applies only to fresh/staging databases until Phase 1 is green-lit.**
Scope: let users manage reminders from ChatGPT, Claude and other MCP clients through a remote server at `https://mcp.nabikaran.org/mcp`, reusing the existing web app's business logic and database.

---

## 1. Where the repository stands today

| Concern | Current implementation | MCP reuse |
| --- | --- | --- |
| Accounts | `users` table, phone-OTP login, JWT cookie session (`src/lib/auth/session.ts`) | identity source for OAuth; cookie session is **not** reused by MCP |
| Expiry tracking | `renewal_items`, AD/BS handling (`src/lib/bs-date.ts`, `src/lib/time.ts`) | reused as-is |
| Scheduling | pure planner `src/lib/scheduler.ts`; `previewSchedule` / `createRenewal` / `updateRenewal` / `setRenewalStatus` in `src/lib/services/renewals.ts` | reused; needs a `Principal` + idempotency key |
| Wallet | SQL functions `wallet_reserve_for_job`, `wallet_commit_for_job`, … (`supabase/migrations/0001_init.sql`); `src/lib/services/wallet.ts` | read-only via MCP; reservations happen inside `createRenewal` |
| SMS delivery | `runDispatcher` / `runReconciler` (`src/lib/services/dispatcher.ts`), provider adapters | never exposed; charging stays in the worker |
| Payments | Khalti/mock gateway, `confirmPaymentByRef` | never exposed; MCP returns a web top-up link |
| Audit | `audit_events` | extended with actor channel/client/token |

The service layer is already the single place that mutates state; every HTTP route is a thin wrapper (`requireUser` → service → JSON). That is the seam the MCP server plugs into. Nothing in the service layer depends on `next/headers`, so it can be called from an MCP tool handler without change.

---

## 2. Target architecture

```
                 ┌────────────────────────────┐     ┌──────────────────────────────┐
  Browser ──────▶│ Web app (Next.js)          │     │ MCP clients                  │
  cookie session │ /api/*  pages              │     │ ChatGPT · Claude · others    │
                 └─────────────┬──────────────┘     └──────────────┬───────────────┘
                               │                                   │ Bearer access token
                               │                        https://mcp.nabikaran.org/mcp
                               │                                   │ (Streamable HTTP)
                               ▼                                   ▼
                 ┌──────────────────────────────────────────────────────────────────┐
                 │ src/lib/core  (shared service layer, Principal-aware)            │
                 │ accounts · renewals · scheduling · wallet(read) · prepared actions│
                 └─────────────┬──────────────────────────────────┬────────────────┘
                               │                                  │
                 ┌─────────────▼──────────────┐     ┌─────────────▼────────────────┐
                 │ PostgreSQL (Supabase)       │     │ OAuth 2.1 authorization server│
                 │ existing tables + 0002      │     │ /oauth/* in the same Next app │
                 └─────────────┬──────────────┘     └──────────────────────────────┘
                               │
                 ┌─────────────▼──────────────┐
                 │ Workers (cron): dispatch,   │   ← the ONLY place credits are debited
                 │ reconcile                   │     and SMS credentials are used
                 └────────────────────────────┘
```

Deployment decision (recommended): **one Next.js deployment, two hostnames.**

- `nabikaran.org` → web app.
- `mcp.nabikaran.org` → same project; a host-based rewrite in `next.config.ts` maps `/` and `/mcp` to `src/app/mcp/route.ts`, and `/.well-known/*` to the OAuth metadata routes. The `WWW-Authenticate` / metadata URLs are computed from `MCP_PUBLIC_URL`.
- No separate database, no new runtime. The MCP route runs the official TypeScript SDK (`@modelcontextprotocol/sdk`) with the Streamable HTTP transport in **stateless mode** (no server-side session store; each request carries the bearer token), which fits serverless and keeps horizontal scaling trivial.
- If MCP traffic later needs isolation, the route moves to `apps/mcp` importing the same `src/lib/core` package. The code boundary is designed for that from day one.

### 2.1 Shared core: `src/lib/core`

Introduce a `Principal` and route every service through it:

```ts
interface Principal {
  userId: string;
  via: "web" | "mcp";
  clientId?: string;      // OAuth client (MCP only)
  tokenId?: string;       // for audit + revocation checks
  scopes: Scope[];        // web sessions carry all user scopes
}
type Scope = "account:read" | "wallet:read" | "reminders:read" | "reminders:write";
```

- `requireScope(principal, "reminders:write")` is enforced in the core, not only at the tool layer, so a future transport cannot bypass it.
- All existing `services/*` functions gain a `principal` parameter (replacing the bare `userId`) and write `audit_events.actor_user_id`, `actor_via`, `actor_client_id`, `actor_token_id`.
- Services are moved/renamed: `services/renewals.ts` → `core/reminders.ts`, `services/wallet.ts` → `core/wallet.ts`, plus new `core/account.ts` and `core/prepared-actions.ts`. The web API routes are updated to build a `Principal` from the cookie session. Behaviour is unchanged for the web app.

---

## 3. Required API / service changes

| Change | Why |
| --- | --- |
| `Principal` parameter on all core functions; scope checks inside core | requirement 6 & 13: identity comes only from a validated token |
| `createRenewal` / `updateRenewal` accept `clientRequestId` (UNIQUE per user) and return the existing result on replay | requirement 9: duplicate `confirm_reminder` calls must not create two renewals or two reservations |
| New `prepareAction()` / `confirmAction()` in `core/prepared-actions.ts` (see §6) | requirement 8: two-step preview-and-confirm with server-held snapshot |
| `previewSchedule` returns machine-readable `warnings[]` (`expiry_in_past`, `bs_date_needs_confirmation`, `insufficient_credits`, `over_cap`) | AI clients must be able to branch on them |
| `ReminderDTO` serializer: expiry in UTC + Nepal local + BS, offsets, per-job status, cost snapshot | one stable shape for web JSON and MCP structured content |
| `getWalletSummary` returns `{available, reserved, posted, topUpUrl}` | MCP can show balance and hand off to web for payment |
| Rate limiter `core/rate-limit.ts` backed by a small `request_counters` table (per token, per user, per tool) | requirement 13; DB-backed like the OTP limiter so it survives restarts |
| Web routes `/api/*` unchanged in contract; internally call core with a web `Principal` | requirement 1 |

Nothing in `dispatcher.ts`, `payments.ts`, `providers/*`, or `admin.ts` is reachable from the MCP layer. These modules will not be imported by `src/app/mcp/**` (enforced with an ESLint `no-restricted-imports` rule).

---

## 4. OAuth 2.1 integration plan

Nabikaran acts as its own **authorization server (AS)** and the MCP endpoint is the **resource server (RS)**, following the MCP authorization specification (revision 2025-06-18; verify against the latest revision on modelcontextprotocol.io before implementation). Reasons: user identity is phone-OTP (custom), tokens must be revocable per client, and no third-party IdP should hold Nepali phone numbers.

### 4.1 Discovery

| Endpoint | Role |
| --- | --- |
| `GET https://mcp.nabikaran.org/.well-known/oauth-protected-resource` | RS metadata: `resource`, `authorization_servers: ["https://nabikaran.org"]`, `scopes_supported`, `bearer_methods_supported: ["header"]` |
| `GET https://nabikaran.org/.well-known/oauth-authorization-server` | AS metadata: `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `token_endpoint_auth_methods_supported: ["none","client_secret_post"]` |
| `401` from `/mcp` | `WWW-Authenticate: Bearer resource_metadata="https://mcp.nabikaran.org/.well-known/oauth-protected-resource"` |

### 4.2 Endpoints (all in the Next app under `src/app/oauth/*`)

- `POST /oauth/register` — RFC 7591 dynamic client registration (ChatGPT and Claude register themselves). Store `client_id`, `redirect_uris` (exact-match, HTTPS only, plus the known loopback/custom schemes for desktop clients), `client_name`, `token_endpoint_auth_method`. Public clients, no secret.
- `GET /oauth/authorize` — requires a web session (redirects to `/login` → phone OTP → back). Shows a **consent page**: client name, requested scopes in plain Nepali/English, the verified phone that will receive reminders. Validates `response_type=code`, `code_challenge` (S256 mandatory), `redirect_uri`, `scope`, `state`, `resource` (RFC 8707, must equal `https://mcp.nabikaran.org/mcp`).
- `POST /oauth/token` — `authorization_code` (+ `code_verifier`) and `refresh_token` grants. Access tokens are **opaque random 256-bit strings, stored hashed** (SHA-256 + pepper), TTL 1 hour, bound to `client_id`, `user_id`, `scopes`, `resource`. Refresh tokens TTL 30 days, **rotated on every use**; reuse of a rotated refresh token revokes the whole family.
- `POST /oauth/revoke` — RFC 7009. Also: Settings page lists connected apps with "Disconnect" (revokes all tokens for that client); account closure revokes everything.

### 4.3 Token validation at the MCP edge

1. Extract bearer; hash; look up `oauth_tokens` where `revoked_at is null and expires_at > now() and resource = MCP_PUBLIC_URL`.
2. Load user; reject if `users.status <> 'active'` or `phone_verified_at is null`.
3. Build `Principal{via:"mcp", clientId, tokenId, scopes}`; update `last_used_at` (throttled).
4. Any `user_id`/phone argument supplied by the AI is **ignored for authorization** — tools do not even accept such parameters.

Opaque tokens (not JWTs) are chosen so revocation is immediate and token contents cannot be inspected or forged offline. One indexed lookup per request is acceptable at pilot scale; a short in-memory cache (≤60 s) can be added later.

---

## 5. Database changes (migration `0002_oauth_mcp.sql`, not yet applied)

```sql
oauth_clients            id text pk, name, redirect_uris text[], auth_method, created_at, disabled_at
oauth_authorization_codes code_hash pk, client_id, user_id, redirect_uri, scopes text[], code_challenge,
                          resource, expires_at (≤10 min), consumed_at
oauth_tokens             id uuid pk, user_id, client_id, kind ('access'|'refresh'), token_hash unique,
                          family_id, scopes text[], resource, expires_at, revoked_at, last_used_at, created_at
prepared_actions         id uuid pk, user_id, client_id, kind ('create_reminder'|'update_reminder'|'cancel_reminder'),
                          input jsonb, preview jsonb, pricing_version, expires_at (15 min), consumed_at,
                          result_ref text, created_at
request_counters         (subject text, window_start timestamptz, bucket text, n int, pk(subject,bucket,window_start))
renewal_items            + client_request_id text, UNIQUE(owner_user_id, client_request_id)
audit_events             + actor_via text, actor_client_id text, actor_token_id uuid
```

RLS: all new tables are service-role only (same policy as `wallet_ledger`). No money table is touched; `wallets`, `wallet_ledger` and the SQL wallet functions are unchanged.

---

## 6. MCP tool schemas

Conventions: all tools return `structuredContent` plus a short text summary; errors use `isError: true` with a stable `code`. Dates are returned in three forms: `expiry_at_utc`, `expiry_local` (Asia/Kathmandu), `expiry_bs` (e.g. `2082-03-15`, Nepali month name). No tool takes a user identifier.

### `get_account` — scope `account:read`
```json
{ "input": {}, "output": { "display_name": "string|null", "phone_masked": "+9779841****67",
  "locale": "ne-NP|en-NP", "timezone": "Asia/Kathmandu", "member_since": "date",
  "connected_client": { "name": "string", "scopes": ["string"] } } }
```

### `get_credit_balance` — scope `wallet:read`
```json
{ "input": {}, "output": { "available_credits": 0, "reserved_credits": 0, "total_credits": 0,
  "credit_value": "1 credit = NPR 1", "credits_per_sms_segment": 3,
  "top_up_url": "https://nabikaran.org/wallet", "note": "Top-ups are completed on the website." } }
```

### `list_reminders` — scope `reminders:read`
```json
{ "input": { "status": "active|paused|cancelled|all (default active)", "category": "bluebook|licence|passport|insurance|warranty|subscription|other",
             "limit": "1..50 (default 20)", "cursor": "string" },
  "output": { "reminders": [ { "id": "uuid", "label": "string", "category": "string",
      "expiry_at_utc": "iso", "expiry_local": "2027-03-01 09:00 NPT", "expiry_bs": "2083 फाल्गुन 17",
      "status": "active|paused|cancelled", "cycle_no": 1,
      "jobs": [ { "offset_minutes": 10080, "due_local": "…", "status": "scheduled|awaiting_credits|planned|submitted|delivered|failed|unknown|cancelled", "estimated_credits": 6 } ] } ],
      "next_cursor": "string|null" } }
```

### `prepare_reminder` — scope `reminders:write` (no side effects on the wallet)
```json
{ "input": {
    "reminder_id": "uuid (omit to create; present to update)",
    "category": "bluebook|licence|passport|insurance|warranty|subscription|other",
    "label": "string ≤80",
    "expiry": { "calendar": "AD|BS", "date": "YYYY-MM-DD", "local_time": "HH:MM (default 09:00)",
                "source": "user_typed|extracted_from_image|inferred",
                "user_confirmed": "boolean" },
    "offsets_minutes": "int[] (presets: 43200,21600,10080,4320,1440,0; max 20)",
    "family_member_label": "string|null", "notes": "string|null" },
  "output": {
    "prepared_id": "uuid", "expires_at": "iso (15 min)",
    "resolved_expiry": { "utc": "iso", "local": "…", "ad": "YYYY-MM-DD", "bs": "YYYY-MM-DD (name)" },
    "schedule": [ { "offset_minutes": 0, "send_local": "…", "sms_text": "…", "segments": 2, "encoding": "UCS-2", "credits": 6, "horizon": "within|beyond" } ],
    "total_credits": 18, "reserved_on_confirm": 18, "available_credits": 50,
    "warnings": [ "bs_date_needs_confirmation|extracted_date_needs_confirmation|insufficient_credits|expiry_in_past|some_offsets_in_past|over_cap|beyond_two_year_horizon" ],
    "requires_user_confirmation": true,
    "confirmation_prompt": "Nepali+English sentence the assistant must show the user before confirm_reminder" } }
```
Rules enforced server-side (requirement 10–11):
- `calendar: "BS"` **or** `source != "user_typed"` ⇒ `requires_user_confirmation: true`, and `confirm_reminder` is refused unless the prepared action was created with `user_confirmed: true` **and** the confirm call repeats the resolved AD date (`expected_expiry_ad`) — a cheap check that the assistant showed the user the converted date.
- Image bytes are never accepted. The assistant extracts structured data on its side, the user confirms, and only the structured fields cross the wire.

### `confirm_reminder` — scope `reminders:write` (reserves credits)
```json
{ "input": { "prepared_id": "uuid", "expected_expiry_ad": "YYYY-MM-DD", "idempotency_key": "string ≤64 (client-generated)" },
  "output": { "reminder": "<ReminderDTO>", "reserved_credits": 18,
              "funding": { "status": "reserved|awaiting_credits", "shortfall_credits": 0, "top_up_url": "…" },
              "replayed": false } }
```
Transactional behaviour: `prepared_actions` row is locked `FOR UPDATE`; if already consumed, the stored `result_ref` is returned with `replayed: true`. Otherwise `createRenewal`/`updateRenewal` runs in the same transaction with `clientRequestId = idempotency_key`; the existing SQL `wallet_reserve_for_job` reserves per job or marks `awaiting_credits`. Prepared actions whose `pricing_version` is no longer current are refused with `code: "price_changed"` (the client must re-prepare; PRD §4 "prices are versioned").

### `update_reminder` — scope `reminders:write`
Thin alias: `prepare_reminder` with `reminder_id` followed by `confirm_reminder`. Also supports non-financial actions directly:
```json
{ "input": { "reminder_id": "uuid", "action": "pause|resume", "idempotency_key": "string" }, "output": { "reminder": "<ReminderDTO>" } }
```
`resume` re-reserves credits (may return `awaiting_credits`); it is idempotent by construction (`wallet_reserve_for_job` is per-job idempotent).

### `cancel_reminder` — scope `reminders:write`
```json
{ "input": { "reminder_id": "uuid", "confirm": true, "idempotency_key": "string" },
  "output": { "reminder_id": "uuid", "cancelled_jobs": 3, "released_credits": 18, "sent_history_kept": true } }
```
Refused with `code: "confirmation_required"` unless `confirm: true`. Releases holds via the existing `cancelUnsentJobs` path; already-sent SMS are never refunded by this tool.

Tool annotations: read tools `readOnlyHint: true`; `prepare_reminder` `readOnlyHint: true` (it writes only its own snapshot); `confirm_reminder`, `update_reminder`, `cancel_reminder` `destructiveHint: false, idempotentHint: true`.

---

## 7. Security and wallet charging model

| Threat / rule | Control |
| --- | --- |
| AI supplies another user's ID | tools have no user parameters; `Principal` only from token |
| Token theft | opaque hashed tokens, 1 h access TTL, refresh rotation with family revocation, audience-bound (`resource`), HTTPS only, per-client disconnect in Settings |
| Scope creep | scope checked in core; `wallet:read` cannot reserve; `reminders:write` cannot read ledger |
| Duplicate confirm | `prepared_actions.consumed_at` + `renewal_items(owner_user_id, client_request_id)` UNIQUE + per-job `wallet_reserve_for_job` idempotency |
| Charging | **unchanged**: MCP never debits. Confirm = reservation only (`reserve ≠ charge`); debit happens once in `runDispatcher` on provider accept via `wallet_commit_for_job(idempotency_key)`; rejected → release; unknown → reconcile |
| Price change between prepare and confirm | prepared action pinned to `pricing_version`; mismatch ⇒ re-prepare |
| Insufficient credits | never overdrafts; returns `awaiting_credits` + shortfall + web top-up URL; auto-scheduled after top-up by existing `retryAwaitingCredits` |
| Abuse / cost inflation | label ≤ 80 chars and sanitised to 40 in SMS (existing); max 10 reminders/renewal; rate limits: 60 tool calls / min / token, 20 `prepare` / 10 min / user, 200 reminders per user (configurable) |
| Secrets | `src/app/mcp/**` may not import `providers/*`, `payments/*`, `services/admin.ts`, `env.aakash`, `env.khalti` (lint rule + review); admin tools are not registered at all |
| Audit | every tool call writes `audit_events(action='mcp.<tool>', actor_via='mcp', actor_client_id, actor_token_id, json_detail_redacted)`; phone numbers redacted |
| Consent | OAuth consent page states the verified phone that will receive SMS; SMS still only ever goes to that number |
| Revocation | `/oauth/revoke`, Settings "Disconnect", account closure, admin kill-switch per client (`oauth_clients.disabled_at`) |
| Transport | Streamable HTTP over HTTPS; `Origin` validation on `/mcp`; JSON-RPC body limit 64 KB; SSE responses only for long tool runs (none expected) |

---

## 8. ChatGPT integration testing instructions

Prerequisites: staging deployment at `https://mcp-staging.nabikaran.org/mcp` with `SMS_PROVIDER=mock`, `PAYMENT_GATEWAY=mock`, a test phone, and the OAuth routes live on `https://staging.nabikaran.org`.

1. **Protocol smoke test (no AI)** — `npx @modelcontextprotocol/inspector`, transport Streamable HTTP, URL `/mcp`. Expect 401 with `WWW-Authenticate` → Inspector performs discovery → registration → PKCE login (phone OTP) → consent → tools list shows exactly 7 tools.
2. **Metadata checks** — `curl https://mcp-staging.nabikaran.org/.well-known/oauth-protected-resource` and `curl https://staging.nabikaran.org/.well-known/oauth-authorization-server` return the documents in §4.1.
3. **ChatGPT** — Settings → Connectors (Developer mode / Apps SDK beta, availability depends on plan) → *Create* → MCP server URL `https://mcp-staging.nabikaran.org/mcp`, auth **OAuth** → ChatGPT registers dynamically and opens the consent flow. Repeat the same with Claude (Settings → Connectors → Add custom connector).
4. **Scripted conversation matrix** (record transcripts as test evidence):
   - "What's my balance?" → `get_credit_balance`, shows top-up URL, no reservation.
   - "Remind me 7 days and 1 day before my Bluebook expires on 2082-03-15 BS" → `prepare_reminder` with `requires_user_confirmation: true`; assistant must show the AD date; `confirm_reminder` with `expected_expiry_ad` → reminder created, holds visible in web wallet.
   - Repeat the same confirm (simulate retry) → `replayed: true`, no second renewal.
   - With 0 credits → `awaiting_credits` + shortfall; top up on web (mock) → job auto-schedules; `list_reminders` shows `scheduled`.
   - "Cancel it" → requires `confirm: true`; holds released.
   - Disconnect in Settings → next call returns 401; ChatGPT re-prompts OAuth.
   - Second test account must never see the first account's reminders (user isolation).
5. **Negative tests** — forged bearer, expired token, token for the wrong `resource`, refresh-token reuse (family revoked), `prepare` with image bytes (rejected), 61st call in a minute (429-equivalent tool error).

---

## 9. Automated tests (requirement 14)

Extend the existing PGlite suites (`tests/*.test.ts`) — no DB server needed:

| Suite | Cases |
| --- | --- |
| `tests/oauth.test.ts` | registration validation; PKCE S256 required, wrong verifier rejected; code single-use; token hashed at rest; refresh rotation and reuse-revokes-family; `resource` audience mismatch rejected; revoke; expired token |
| `tests/mcp-auth.test.ts` | 401 + `WWW-Authenticate` without token; `Principal` built only from token; tool call with scope missing is refused; closed/unverified user refused |
| `tests/mcp-isolation.test.ts` | user A's token cannot list/update/cancel user B's reminder (404, not 403, to avoid existence leaks) |
| `tests/mcp-idempotency.test.ts` | double `confirm_reminder` ⇒ one renewal, one set of reservations; concurrent confirms (Promise.all) ⇒ one winner; expired/consumed prepared id refused; price-version mismatch refused |
| `tests/mcp-wallet.test.ts` | insufficient credits ⇒ `awaiting_credits`, wallet unchanged; top-up then auto-schedule; cancel releases; MCP cannot reach `wallet_apply_topup`/adjustment functions (no such tool, lint rule test) |
| `tests/mcp-scheduling.test.ts` | BS date requires confirmation; `expected_expiry_ad` mismatch refused; offsets in the past dropped with warning; cap at 10; beyond-horizon planned |
| `tests/mcp-ratelimit.test.ts` | per-token and per-user windows |

---

## 10. Phased implementation plan

| Phase | Work | Exit gate | Infra / money impact |
| --- | --- | --- | --- |
| **0 — Core refactor** (2–3 days) | `src/lib/core` with `Principal`, scopes, `clientRequestId` idempotency, `ReminderDTO`, warnings; web routes migrated; lint boundary | all 46 existing tests + new core tests green; web behaviour unchanged | none (code only) |
| **1 — OAuth AS + schema** (3–4 days) | migration `0002` (new tables only), `/oauth/*`, consent page, Settings "Connected apps", metadata endpoints | `tests/oauth.test.ts` green; manual PKCE flow with MCP Inspector | **requires approval**: apply migration to staging, then production; no wallet tables touched |
| **2 — MCP read tools** (2 days) | `src/app/mcp/route.ts` (SDK, stateless Streamable HTTP), host rewrite for `mcp.nabikaran.org`, `get_account`, `get_credit_balance`, `list_reminders`, audit + rate limits | Inspector + Claude/ChatGPT connect and list reminders on staging | **requires approval**: DNS for `mcp.nabikaran.org`, `MCP_PUBLIC_URL` env |
| **3 — Write tools** (3–4 days) | `prepared_actions`, `prepare_reminder`, `confirm_reminder`, `update_reminder`, `cancel_reminder`; BS/extracted-date confirmation rules | idempotency, isolation, insufficient-credit and scheduling suites green; conversation matrix §8 recorded | reservations only; charging path unchanged |
| **4 — Hardening & launch** (2–3 days) | token cache, admin client kill-switch, monitoring (tool error rate, 401 rate), privacy/terms update for connected apps, ChatGPT/Claude directory submission | security review of §7 signed off; production go/no-go | production enablement |

Total ≈ 2.5–3 weeks of engineering after the web pilot is stable. Phases 0 and 3 are pure application code; Phases 1, 2 and 4 each need an explicit go-ahead for schema, DNS and production enablement.

---

## 11. Decisions requested

1. Approve the single-deployment / two-hostname topology (vs. separate MCP service now).
2. Approve Nabikaran as its own OAuth authorization server with opaque hashed tokens.
3. Approve the scope set (`account:read`, `wallet:read`, `reminders:read`, `reminders:write`) and that top-ups remain web-only.
4. Approve the BS/extracted-date double-confirmation rule (`user_confirmed` + `expected_expiry_ad`).
5. Green-light Phase 0 (code-only refactor) to start now.

---

## 12. Phase 0 — implemented (code-only)

| Item | Where |
| --- | --- |
| `Principal` + scopes, scope checks inside core | `src/lib/core/principal.ts`; every core function calls `requireScope` |
| Transport-agnostic errors (`HttpError`, `ScopeError`, `RateLimitError`) | `src/lib/core/errors.ts` (re-exported by `src/lib/http.ts`) |
| Idempotent mutations (`idempotency_keys`, per user + operation, concurrent-safe, stored response replayed) | `src/lib/core/idempotency.ts`; used by create/update/status in `core/reminders.ts`; web form sends one key per confirmation |
| `ReminderDTO` / `InstantDTO` (UTC + NPT + AD + BS) and `SchedulePreview` with `warnings[]` | `src/lib/core/dto.ts`, `previewSchedule` |
| `getAccount`, `getWalletSummary` (`topUpUrl`, price), `listReminders` with cursor pagination | `src/lib/core/account.ts`, `core/wallet.ts`, `core/reminders.ts` |
| DB-backed fixed-window rate limiter | `src/lib/core/rate-limit.ts` (`request_counters`) |
| Audit actor channel/client/token | migration `0002`, `src/lib/core/audit.ts` |
| Web routes/pages migrated to `requirePrincipal()` → core | `src/app/api/renewals/**`, `/api/wallet`, dashboard/renewals/wallet pages |
| Import boundary test (core and future `src/app/mcp` cannot import providers, payments, dispatcher, admin or `next/*`) | `tests/boundary.test.ts` |
| Tests: scopes, isolation, duplicate/concurrent confirms, key binding, insufficient credits, BS warnings, pagination, audit, rate limit | `tests/core.test.ts` (+ existing suites updated) — 61 tests |

Deviation from §5: create/update idempotency uses a generic `idempotency_keys(user_id, key)` table instead of `renewal_items.client_request_id`, so the same mechanism covers cancel/pause/resume and, in Phase 3, `confirm_reminder`.

Not in Phase 0 (by design): OAuth tables/endpoints, `prepared_actions`, the `/mcp` route, DNS. Phase 1 starts on your go-ahead.

## 13. Phase 1 — implemented (OAuth 2.1 authorization server)

| Item | Where |
| --- | --- |
| Migration `0003` (additive): `oauth_clients`, `oauth_authorization_codes`, `oauth_tokens`, `prepared_actions` | `supabase/migrations/0003_oauth.sql` |
| Dynamic client registration (RFC 7591), redirect-URI policy (https / loopback / private scheme, exact match, loopback port variance) | `src/lib/oauth/clients.ts`, `POST /oauth/register` (CORS, 10/h/IP) |
| Authorization request validation: `response_type=code`, PKCE **S256 only**, registered `redirect_uri`, known scopes (default: all four), `resource` must equal `MCP_PUBLIC_URL` | `src/lib/oauth/codes.ts` |
| Consent page (phone that will receive SMS, scope text in English + Nepali, Allow/Deny), same-origin decision POST, `iss` on redirect | `src/app/oauth/authorize/page.tsx`, `.../decision/route.ts`; login supports `?next=` |
| Token endpoint: code + PKCE → opaque 256-bit tokens stored as SHA-256; access 1 h, refresh 30 d; refresh **rotation** with family revocation on reuse; code replay revokes derived tokens; scope may narrow, never widen | `src/lib/oauth/tokens.ts`, `POST /oauth/token` (form or JSON, CORS, 60/min/client) |
| Revocation (RFC 7009), Settings → Connected apps → Disconnect, revoke-all on account closure, admin kill-switch via `oauth_clients.disabled_at` | `POST /oauth/revoke`, `/api/me/connections`, `ConnectedApps` |
| Resource-server validation `verifyAccessToken()` → `Principal` (checks revoked/expired/resource/client disabled/user active+verified); the only identity path for MCP | `src/lib/oauth/tokens.ts` |
| Discovery: RFC 8414 AS metadata, RFC 9728 protected-resource metadata, `WWW-Authenticate` builder | `src/lib/oauth/metadata.ts`, `/.well-known/*` |
| Housekeeping in reconciler: expired codes/tokens and rate-limit windows pruned | `/api/jobs/reconcile` |
| Tests (`tests/oauth.test.ts`): redirect policy, confidential clients, PKCE/redirect/resource/scope validation, code single-use + replay revocation, hashes at rest, rotation + reuse detection, token validation failure modes, cross-token isolation, disconnect, metadata | 14 tests; suite total 75 |

Env: `OAUTH_ISSUER` (web origin) and `MCP_PUBLIC_URL` (e.g. `https://mcp.nabikaran.org/mcp`). Phase 2 (the `/mcp` route + read tools, DNS for `mcp.nabikaran.org`) starts on your go-ahead.
