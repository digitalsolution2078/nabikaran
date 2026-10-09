# Deploying and running Nabikaran on the Hostinger VPS

Production runs as a **Hostinger Docker Manager stack in `/docker/nabikaran`**. Sections 1–6 describe that setup. Section 7 is the alternative layout for a fresh server, using this repository's own `docker-compose.yml` and `deploy/deploy.sh`. Production does **not** use it.

The VPS also hosts other projects (n8n, ssf-guide, ds_academy_lms, narikot-books, rabinpaudel, himexa, digital-solution-oms20, shram-app, idp-app). Never stop, recreate or prune anything outside the `nabikaran-*` containers.

## 1. Production at a glance

| Item | Value |
|---|---|
| Stack directory | `/docker/nabikaran` |
| Compose file | `/docker/nabikaran/docker-compose.yml` (managed by Hostinger Docker Manager, not in this repo) |
| Web app | container `nabikaran-web-1` (`node:22-alpine`, port 3000 inside). On every recreate it clones `main` from GitHub, runs `npm ci` and builds. |
| Scheduler | container `nabikaran-scheduler-1` (`alpine:3.20`), calls the worker endpoints on a timer |
| Database | container `nabikaran-db-1` (`postgres:16-alpine`), user and database `nabikaran` |
| Migration ledger | table `_schema_migrations` (not `schema_migrations`) |
| Public proxy | `n8n-traefik-1` owns ports 80/443 and routes `nabikaran.org` to the web container |
| Deploy script | `/root/nabikaran-deploy.sh` (server only, not in this repo) |
| Backups and deploy log | `/root/backups/nabikaran/` (`deploys.log` is in the same folder) |
| Health | `https://nabikaran.org/api/health` → `{"status":"ok","db":"ok",…}` |
| Not used | `/opt/apps/nabikaran`, an old clone on a feature branch. It is safe to delete once you are sure nothing points to it (see §6). |

Shorthand used below:

```bash
NB="docker compose --project-directory /docker/nabikaran -f /docker/nabikaran/docker-compose.yml"
```

To see how the stack itself is wired (env file, start commands, Traefik labels) without printing secret values:

```bash
grep -nE "image:|command:|entrypoint:|env_file|labels:|traefik|networks:" /docker/nabikaran/docker-compose.yml
```

## 2. Everyday commands

| Task | Command |
|---|---|
| Container status | `docker ps --filter name=nabikaran- --format 'table {{.Names}}\t{{.Status}}'` |
| Health (from the server) | `curl -s https://nabikaran.org/api/health` |
| Health (inside the web container) | `docker exec nabikaran-web-1 node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>r.text()).then(console.log)'` |
| Web logs | `docker logs --since 1h nabikaran-web-1 2>&1 \| tail -200` |
| Errors only | `docker logs --since 1h nabikaran-web-1 2>&1 \| grep -iE "error\|dashboard"` |
| Scheduler logs | `docker logs --since 1h nabikaran-scheduler-1 2>&1 \| tail -50` |
| SQL shell | `docker exec -it nabikaran-db-1 psql -U nabikaran -d nabikaran` |
| Applied migrations | `docker exec nabikaran-db-1 psql -U nabikaran -d nabikaran -c "select * from _schema_migrations order by 1"` |
| Manual backup | `docker exec nabikaran-db-1 sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \| gzip > /root/backups/nabikaran/manual-$(date +%F-%H%M).sql.gz` |
| Deploy latest `main` now | `bash /root/nabikaran-deploy.sh` |
| Deploy history | `tail -20 /root/backups/nabikaran/deploys.log` |
| Uptime monitor | `GET https://nabikaran.org/api/health` (503 = dispatcher stalled ≥ 3 min or DB down) |

### Changing environment variables

Variables such as `SMS_PROVIDER`, `AAKASH_AUTH_TOKEN`, `PAYMENT_GATEWAY`, `KHALTI_*`, `FONEPAY_*`, `WHATSAPP_*`, `LEGAL_ENTITY_NAME`, `LEGAL_ADDRESS`, `SUPPORT_EMAIL` and `SUPPORT_PHONE` belong to the stack, not to the repository. `.env.production.example` lists every variable with a comment.

1. Edit them where the compose file reads them: the `env_file` it names, or the stack's environment in **hPanel → VPS → Docker Manager → nabikaran**. Never paste their values into chat, GitHub or the admin panel.
2. Apply them:
   - **Web only:** `bash /root/nabikaran-deploy.sh` (it backs up first and recreates `web`).
   - **Scheduler too:** `$NB up -d --no-deps --force-recreate web scheduler`.

Because the web container rebuilds when it is recreated, **the site is unavailable for a few minutes**, until `/api/health` answers again. Do it at a quiet time.

## 3. Automatic deploys (as they run today)

`.github/workflows/deploy.yml` runs after **CI** passes on a push to `main`, or by hand from **Actions → Deploy → Run workflow**. It connects over SSH as `DEPLOY_USER@DEPLOY_HOST`.

The key in `/root/.ssh/authorized_keys` carries a forced command, so the server ignores the command the workflow sends and runs only `/root/nabikaran-deploy.sh`:

```
command="/root/nabikaran-deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… github-actions-deploy
```

`/root/nabikaran-deploy.sh` does this:

1. takes a lock, so only one deploy runs at a time;
2. reads the latest `origin/main` commit (`git ls-remote`);
3. backs up the database from `nabikaran-db-1` to `/root/backups/nabikaran/` (keeps the newest 14);
4. recreates **only** the web service (`$NB up -d --no-deps --force-recreate web`), which clones `main`, installs and builds inside the container;
5. polls `/api/health` inside `nabikaran-web-1` every 5 s for up to 10 minutes;
6. writes the result to `/root/backups/nabikaran/deploys.log`.

What that means in practice:

- **It always deploys the latest `main`.** A commit SHA chosen in *Run workflow* is logged but not honoured. To run an older version, revert on `main`.
- **There is no automatic rollback.** If the health check fails, the run turns red and the broken build stays up until you act (see "Recovering" below).
- **The scheduler and database are not recreated.** Restart the scheduler yourself when its environment changes (§2).
- **Expect a few minutes of downtime per deploy**, because the build happens after the old container is replaced.
- Migrations are applied by the stack itself (recorded in `_schema_migrations`). After a deploy that adds a migration, confirm it with the *Applied migrations* command in §2.

GitHub secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | VPS IP or hostname |
| `DEPLOY_USER` | `root` |
| `DEPLOY_SSH_KEY` | the private key whose public half has the forced command above |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -p 22 <VPS IP>` |
| `DEPLOY_PORT` | only if SSH is not on 22 |
| `DEPLOY_PATH` | not needed. The forced command overrides the path the workflow sends. |

Rules that keep auto-deploy safe:

- Add new environment variables to the stack **before** merging code that needs them; the deploy never edits them.
- Keep `/root/nabikaran-deploy.sh` and the stack's `docker-compose.yml` backed up outside the server. Neither is in this repository.
- Optional: **Settings → Environments → production → Required reviewers** makes every deploy wait for your approval.

### Recovering from a bad release

Fix forward if you can: revert the commit on `main` and let the next deploy (or `bash /root/nabikaran-deploy.sh`) rebuild.

Migrations are additive, so code rollback rarely needs a data restore. If data must be restored, use the backup taken just before the failed deploy (newest file in `/root/backups/nabikaran/`):

```bash
ls -1t /root/backups/nabikaran/*.sql.gz | head -3
docker stop nabikaran-web-1 nabikaran-scheduler-1
docker exec nabikaran-db-1 psql -U nabikaran -d postgres \
  -c "drop database nabikaran" -c "create database nabikaran owner nabikaran"
gunzip -c /root/backups/nabikaran/<file>.sql.gz | docker exec -i nabikaran-db-1 psql -q -U nabikaran -d nabikaran
docker start nabikaran-scheduler-1 nabikaran-web-1
curl -s https://nabikaran.org/api/health
```

A restore discards every top-up, sign-in fee and message charge made after the backup was taken. Reconcile with the bank or Fonepay statement before you reopen top-ups.

## 4. Owner bootstrap (one time)

Sign in once at `https://nabikaran.org/login` with your own number, then:

```bash
docker exec nabikaran-db-1 psql -U nabikaran -d nabikaran -c "select bootstrap_super_admin('+977XXXXXXXXXX');"
```

This works only once; the database refuses it when a super admin already exists. Sign out and back in, then open `/admin`. Full procedure: `docs/ADMIN_AND_PAYMENTS.md`.

## 5. DNS and proxy

| Type | Name | Value |
|---|---|---|
| A | `@` | `<VPS IPv4>` |
| A | `www` | `<VPS IPv4>` |
| A | `mcp` | `<VPS IPv4>` |

`n8n-traefik-1` terminates HTTPS for `nabikaran.org`, `www` and `mcp`. The routing rules are labels on the web service in the stack's compose file. Check them with:

```bash
docker inspect nabikaran-web-1 --format '{{json .Config.Labels}}' | tr ',' '\n' | grep -i traefik
```

`mcp.nabikaran.org` needs its own Traefik router and the `MCP_HOST`, `MCP_PUBLIC_URL` and `OAUTH_ISSUER` variables. The full ChatGPT/Claude connector runbook is in `docs/MCP_SETUP.md`.

A second Traefik (`traefik-tzhk-traefik-1`) cannot bind 80/443 because `n8n-traefik-1` already holds them, so it restarts endlessly. It serves nothing. Stopping it (`docker update --restart=no traefik-tzhk-traefik-1 && docker stop traefik-tzhk-traefik-1`) removes the noise. Before you do, confirm that no other project relies on it.

Verify after any proxy change:

```bash
curl -sI https://nabikaran.org | head -3
curl -s https://mcp.nabikaran.org/.well-known/oauth-protected-resource   # resource = https://mcp.nabikaran.org/mcp
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.nabikaran.org/      # 401 (needs a token — correct)
```

## 6. Housekeeping

- `/opt/apps/nabikaran` is not used by production. Before deleting it, remove the matching unused line `command="/opt/apps/nabikaran/deploy/ssh-deploy.sh"` from `/root/.ssh/authorized_keys`. Back up the file first (`cp /root/.ssh/authorized_keys /root/.ssh/authorized_keys.bak`), and keep the `/root/nabikaran-deploy.sh` line, because GitHub uses it.
- `/root/nabikaran-deploy.sh` already keeps 14 backups. For a daily backup independent of deploys, add to `crontab -e`:
  ```
  15 2 * * * docker exec nabikaran-db-1 sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > /root/backups/nabikaran/daily-$(date +\%F).sql.gz && find /root/backups/nabikaran -name 'daily-*.sql.gz' -mtime +14 -delete
  ```
- Copy backups off the server regularly. A backup on the same disk does not survive losing the VPS.

---

## 7. Alternative: fresh install with this repository's compose file

Use this only on a new server. It is a different layout from production, so do not mix it into `/docker/nabikaran`.

It runs four containers (`db`, `migrate`, `app`, `cron`); migrations go in `schema_migrations` through `deploy/migrate.sh`:

```bash
mkdir -p /opt/apps && cd /opt/apps
git clone https://github.com/digitalsolution2078/nabikaran.git && cd nabikaran
cp .env.production.example .env.production
for k in POSTGRES_PASSWORD SESSION_SECRET OTP_PEPPER WORKER_TOKEN; do echo "$k=$(openssl rand -hex 32)"; done
nano .env.production && chmod 600 .env.production   # keep SMS_PROVIDER=mock, PAYMENT_GATEWAY=mock at first
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps        # db healthy, migrate exited (0), app + cron up
curl -s http://127.0.0.1:3100/api/health
```

For proxy options (Nginx Proxy Manager, Traefik labels, Caddy, Nginx), see the commented blocks in `docker-compose.yml`. The app listens on `127.0.0.1:3100`.

For automatic deploys in this layout, point the forced command at `/opt/apps/nabikaran/deploy/ssh-deploy.sh`. It hands the CI-tested commit to `deploy/deploy.sh`, which:

1. refuses local edits and commits that are not on `main`;
2. backs up the database;
3. builds while the old version keeps serving;
4. runs migrations before the app starts;
5. health-checks the app;
6. rolls back to the previous commit on failure.

Set `DEPLOY_PATH` only if the clone is elsewhere.

## Prompt for Claude for Chrome (production checks)

```
You are helping me operate Nabikaran on my Hostinger VPS. Production is the Docker Manager stack in /docker/nabikaran with containers nabikaran-web-1, nabikaran-scheduler-1 and nabikaran-db-1; follow docs/DEPLOY_VPS.md §1–§6 in github.com/digitalsolution2078/nabikaran. Use the hPanel Browser terminal. Show me each command before running it and stop if the output differs from what the guide expects.

Never print environment files or secret values. Do not stop, recreate or prune any container whose name does not start with nabikaran-. Do not run DROP, DELETE, UPDATE or a restore without my explicit approval.

1. Show container status, the health endpoint and the last 20 lines of /root/backups/nabikaran/deploys.log.
2. List applied migrations from _schema_migrations and compare them with supabase/migrations in the repo.
3. Show web errors from the last hour (docker logs --since 1h nabikaran-web-1 2>&1 | grep -iE "error|dashboard") and summarise them.
4. Report anything unexpected, and propose a fix before running it.
```
