# Nabikaran private mock staging

## Audit evidence and deployment decision

- Namecheap order #216251386, dated 2026-10-09, confirms `nabikaran.org`
  registration and domain privacy for one year. No hosting or SSL purchase is
  listed. Do not commit the full email, billing details or credentials.
- Audited `main` release: `ee4e16a5b654cb56c02dfe4b05c431f08064a80b`.
  Default branch: `claude/bold-brahmagupta-zglkbf` at `30f0c6d`; these refs had
  identical tracked trees during this audit. Use explicit release refs.
- GitHub run 37971013602 / job 113957338306 executed SSH deployment and logged
  successful deployment of `ee4e16a`. It did not merely skip the deploy job.
  **Drift:** its server log says `recreating web (clone main, npm ci, build)`,
  unlike the tracked Docker deploy script. Actual server Compose layout,
  environment, hosting account ownership and proxy are not yet inspected.
- Recursive DNS: NS `dns1.registrar-servers.com`, `dns2.registrar-servers.com`;
  apex A `69.62.75.166`; staging A returns NXDOMAIN. These results do not
  independently prove the IP is an owned Hostinger VPS.
- Read-only HTTPS checks: apex `/` = 200; `/api/health` = 200 with DB and
  dispatcher healthy; MCP discovery on `mcp.nabikaran.org` = 502.
  No DNS, server, live provider or production changes were made by this audit.

| Path | Fit with current code | Operational evidence |
| --- | --- | --- |
| VPS / Docker / PostgreSQL | Standalone Next bundle, Compose, six SQL migrations, worker cron, SSH workflow | SSH deploy executed; installed script differs and needs inspection |
| Vercel / Supabase | App can use PostgreSQL; Vercel cron config exists | No connected project/plan evidence; verify minute-level cron, worker authorization, migrations and host rewrites separately |

**Selected configuration path:** isolated VPS/Docker staging, subject to server
ownership, capacity and topology checks. Do not migrate the running production
app or adopt Vercel merely to resolve stale documentation.

## 1. Confirm host and authoritative DNS before writes

Inspect the owned VPS account, running containers, volumes, disk/RAM, proxy
configuration and installed deploy script through an authenticated connection.
Do not infer SSH credentials from DNS. GitHub Actions secrets are not readable
through this connector. Do not trigger the production workflow for staging.

Recheck parent delegation, then query both authoritative servers:

```sh
dig +trace nabikaran.org NS
dig @dns1.registrar-servers.com nabikaran.org SOA +norecurse
dig @dns2.registrar-servers.com nabikaran.org SOA +norecurse
dig @dns1.registrar-servers.com staging.nabikaran.org A +norecurse
dig @dns2.registrar-servers.com mcp-staging.nabikaran.org A +norecurse
```

Stop if delegation differs or answers disagree. Export current DNS records.
If current registrar-servers NS remain authoritative, change records in
Namecheap Advanced DNS. Preserve all existing records and nameservers.

| Planned type | Host | Value | TTL |
| --- | --- | --- | --- |
| A | staging | confirmed owned staging VPS IPv4 | 300 if provider permits |
| A | mcp-staging | confirmed owned staging VPS IPv4 | 300 if provider permits |

Do not use `69.62.75.166` until its ownership and staging proxy are verified.
Do not add AAAA without a configured/reachable IPv6 listener. Preserve CAA;
verify it permits the certificate issuer before requesting SSL. Keep apex,
www and production MCP records unchanged.

## 2. Prepare a separate checkout and secrets

Use `/opt/apps/nabikaran-staging`, separate from production. Check out the
reviewed staging commit. Do not use `deploy/deploy.sh` for staging.
Copy `.env.staging.example` to `.env.staging`, and populate the four independent
secrets with 64 hexadecimal characters each. A password in this alphabet avoids
connection-string escaping errors. Keep this file mode 600 and outside git.
Never reuse production secrets, provider credentials, user data or DB backups.

`docker-compose.staging.yml` is a **standalone** Compose file, not an override.
It uses a separate project, database, volume, image and loopback port 3200.
There are no fixed container names. Confirm that port 3200 is unused first.

```sh
docker compose --env-file .env.staging -f docker-compose.staging.yml config --quiet
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
docker compose --env-file .env.staging -f docker-compose.staging.yml ps -a
curl --fail http://127.0.0.1:3200/api/health
```

Do not print expanded Compose config: it contains secrets. Reject blank or
placeholder secrets before start. All six migrations run in lexical order,
tracked by `schema_migrations`; staging settings then disable manual merchant
QR and WhatsApp. Require migration exit 0 and six recorded migrations. Only
synthetic users should be created. The container forces mock SMS, mock Khalti,
mock Fonepay, WhatsApp off and blank live credentials. Do not restore production
DB data or enable manual QR in the staging admin panel.

## 3. Private proxy and SSL

Use `deploy/Caddyfile.staging.example` only if Caddy already runs on the host.
Set `STAGING_ALLOWED_CIDRS` in the Caddy service environment to the testers'
verified public IPs or a VPN gateway CIDR, validate config, then reload. A
missing/nonmatching allowlist must not grant access. Both hosts use the same
staging container. Docker-based proxies need a separately reviewed network
attachment; a container's localhost is not the host's localhost.

Issue trusted certificates only after DNS/CAA propagation and confirming port
80/443 routing. Test certificate hostname, chain, expiry and HTTP-to-HTTPS
redirect without `curl -k`. Unallowed clients must receive 403; allowed testers
must receive the application. Set noindex headers. Do not expose PostgreSQL or
port 3200 publicly. Keep a single app instance: mock payment state is in-memory
and is lost on restart; never treat mock balances as real money.

## 4. Staging tests and evidence

Expected URLs (not deployed by this audit):
`https://staging.nabikaran.org` and `https://mcp-staging.nabikaran.org/mcp`.

- `/api/health`: DB ok and dispatcher ok / HTTP 200 after the first worker tick.
  A 503 before the first tick is not a successful readiness check.
- Request OTP for a synthetic test number; retrieve it from restricted app
  logs. Production-mode mock OTP is **not** returned on the login page.
  Protect logs: mock SMS logs the recipient and code.
- Complete mock top-up and verify credit once; replay must not double-credit.
  Test mock QR at the service layer; keep the manual QR UI disabled.
- Reminder create/fund/dispatch/pause/cancel; mock acceptance, rejection,
  unknown-outcome reconciliation; balance/hold invariants; account isolation.
- Worker endpoints: unauthorized requests fail. Confirm scheduler heartbeats.
- OAuth discovery returns staging issuer/resource; unauthenticated MCP returns
  401 for allowed clients. Inspector flow, revocation and tests in launch
  checklist B/C must be recorded, not assumed from local unit tests.
- Backup/restore drill using synthetic staging data, separate backup storage.
- From outside the tester allowlist verify access is denied.

Local evidence: 180 tests passed (179 existing plus staging-settings regression), including migration-backed
wallet/auth/reminder/RBAC/OAuth/MCP flows. Remote staging, real PostgreSQL 16
container migration, Docker build, TLS and proxy tests remain unverified until
the host is accessible. Local PGlite tests do not replace those checks.

## 5. Production blockers

1. Inspect installed server script drift, commit/container identity and hosting
   ownership; establish a safe staging-only deployment route.
2. Publish and verify private staging DNS/TLS, all smoke tests and restore drill.
3. Diagnose existing production MCP discovery 502 without changing live DNS
   blindly; check upstream routing and host rewrite/resource configuration.
4. Verify production SMS/payment/WhatsApp modes from the runtime environment
   without exposing secrets; public health does not prove their modes.
5. Obtain merchant/provider approvals, sandbox evidence, sender/billing rules,
   signed callback/idempotency tests and wallet reconciliation sign-off.
6. Review legal/support fields, backup retention, monitoring and incident
   recovery; verify SSH host-key pinning and release branch policy.
7. Obtain explicit production launch approval. This PR does not launch or
   enable live SMS/payments and must not auto-merge into a production deployment.
