# Deploying Nabikaran on a Hostinger VPS (Docker)

Target: a VPS that already runs other projects in Docker behind a reverse proxy. Nabikaran adds four containers (`db`, `migrate`, `app`, `cron`) on its own internal network and is reached only through your existing proxy. Nothing else on the server is touched.

Requirements: Ubuntu 22.04/24.04 VPS, Docker Engine + Compose plugin, ≥ 2 GB RAM (the Next build needs ~1.5 GB briefly; add swap if you have 1–2 GB), two DNS records.

## 1. DNS — use the authoritative provider, not the hosting provider

`nabikaran.org` was registered at Namecheap on 2026-10-09 for one year.
At the 2026-10-09/10 audit, recursive DNS returned
`dns1.registrar-servers.com` and `dns2.registrar-servers.com`, with apex A
`69.62.75.166`. Reconfirm delegation and query both authoritative servers
before any write. If these nameservers remain active, use Namecheap Advanced
DNS; Hostinger hPanel is not authoritative merely because the VPS is there.
Export current records first; preserve MX/TXT/CAA/DNSSEC and existing services.
Do not change nameservers. Do not change apex/www/mcp during staging setup.

For private mock staging use [STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md).
The following production records are a plan, not authorization to publish:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | `<VPS IPv4>` | 300 |
| A | `www` | `<VPS IPv4>` | 300 |
| A | `mcp` | `<VPS IPv4>` | 300 |

Both `nabikaran.org` and `mcp.nabikaran.org` point at the same app; the app itself serves `/` on `mcp.nabikaran.org` as the MCP endpoint. `MCP_HOST` is baked in at image build time (compose passes it as a build arg from `.env.production`), so changing it means `up -d --build`.

## 2. Get the code and secrets onto the VPS

```bash
ssh root@<VPS IP>
mkdir -p /opt/apps && cd /opt/apps
git clone https://github.com/digitalsolution2078/nabikaran.git
cd nabikaran
cp .env.production.example .env.production
# generate four secrets and paste them into .env.production
for k in POSTGRES_PASSWORD SESSION_SECRET OTP_PEPPER WORKER_TOKEN; do echo "$k=$(openssl rand -hex 32)"; done
nano .env.production      # set the four secrets; keep SMS_PROVIDER=mock and PAYMENT_GATEWAY=mock for the first run
chmod 600 .env.production
```

Private repo? Create a read-only deploy key (`ssh-keygen -t ed25519 -f ~/.ssh/nabikaran_deploy`), add the public key under GitHub → repo → Settings → Deploy keys, and clone with the SSH URL.

## 3. Start

```bash
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps          # db healthy, migrate exited (0), app + cron up
docker compose --env-file .env.production logs -f migrate app cron   # Ctrl-C to stop following
curl -s http://127.0.0.1:3100/api/health             # {"status":"ok"...} after the first cron tick (≤ 1–2 min)
```

The `migrate` container applies `supabase/migrations/*.sql` once each (tracked in `schema_migrations`) on every `up`, so upgrades are just `git pull && docker compose --env-file .env.production up -d --build`.

## 4. Reverse proxy — pick the one you already run

**Nginx Proxy Manager (Docker)** — two proxy hosts, both → scheme `http`, forward host `nabikaran-app`, port `3000` (if NPM is on a shared Docker network: uncomment `proxy` under `networks` in `docker-compose.yml` and set `external: true`), or forward host `host.docker.internal` / the VPS private IP, port `3100`. Enable *Websockets support* and *Block common exploits*; SSL tab → *Request a new certificate*, *Force SSL*, *HTTP/2*.
- Host 1: `nabikaran.org`, `www.nabikaran.org`
- Host 2: `mcp.nabikaran.org`

**Traefik (Docker)** — uncomment the `labels` block and the `proxy` network in `docker-compose.yml`, adjust the entrypoint/certresolver names to yours, `docker compose up -d`.

**Caddy / Nginx on the host** — add:

```caddy
nabikaran.org, www.nabikaran.org, mcp.nabikaran.org {
    reverse_proxy 127.0.0.1:3100
}
```

```nginx
server {
    server_name nabikaran.org www.nabikaran.org mcp.nabikaran.org;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
        proxy_buffering off;          # MCP responses may stream
    }
}
# then: certbot --nginx -d nabikaran.org -d www.nabikaran.org -d mcp.nabikaran.org
```

## 5. Verify

```bash
curl -sI https://nabikaran.org | head -3
curl -s https://mcp.nabikaran.org/.well-known/oauth-protected-resource      # resource = https://mcp.nabikaran.org/mcp
curl -s https://nabikaran.org/.well-known/oauth-authorization-server | head -c 300
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.nabikaran.org/            # 401 (needs a token — correct)
```

Then: open `https://nabikaran.org/login`, enter your number; with `SMS_PROVIDER=mock` the OTP is printed in `docker compose logs app` (and shown on the page). Make yourself the owner (Super Admin). This works **once**: the database refuses it when a super admin already exists.

```bash
docker compose --env-file .env.production exec db psql -U nabikaran -d nabikaran -c "select bootstrap_super_admin('+977XXXXXXXXXX');"
```

Sign out and back in, then open `/admin`. Add further admins from **Admin → Users → (user) → Role**. Full procedure: `docs/ADMIN_AND_PAYMENTS.md`.

Finally run the MCP smoke test from `docs/LAUNCH_CHECKLIST.md` §B (Inspector) and connect Claude/ChatGPT.

## 6. Operations

| Task | Command |
| --- | --- |
| Upgrade | `cd /opt/apps/nabikaran && git pull && docker compose --env-file .env.production up -d --build` |
| Logs | `docker compose --env-file .env.production logs -f app` |
| DB backup (daily cron) | `docker compose --env-file .env.production exec -T db pg_dump -U nabikaran nabikaran \| gzip > /opt/backups/nabikaran-$(date +%F).sql.gz` |
| Restore | `gunzip -c file.sql.gz \| docker compose --env-file .env.production exec -T db psql -U nabikaran nabikaran` |
| Switch SMS to live | set `SMS_PROVIDER=aakash` + `AAKASH_AUTH_TOKEN`, then `up -d` |
| Switch payments to live | set `PAYMENT_GATEWAY=khalti`, `KHALTI_SECRET_KEY`, `KHALTI_BASE_URL=https://a.khalti.com`, then `up -d` |
| Uptime monitor | `GET https://nabikaran.org/api/health` (503 = dispatcher stalled ≥ 3 min or DB down) |

Add the backup line to `crontab -e` as `15 2 * * * …` and keep 14 days (`find /opt/backups -mtime +14 -delete`).

---

## 7. Automatic deploys (GitHub Actions)

After this is set up, every push to `main` that passes CI is deployed automatically. The workflow (`.github/workflows/deploy.yml`) connects over SSH and runs `deploy/deploy.sh`, which:

1. refuses to run if someone edited tracked files on the server, or if another deploy is running;
2. backs up the database to `~/backups/nabikaran/` (keeps the newest 14);
3. checks out the exact commit that passed CI (only commits on `main` are accepted);
4. builds the new image while the old version keeps serving;
5. runs `docker compose up -d` — migrations run first, and the app starts only if they succeed;
6. checks `/api/health` inside the app container;
7. if the build, migrations or health check fail, rebuilds and starts the previous commit and marks the run failed.

Migrations are additive and are not rolled back automatically. To restore data after a bad release, use the backup printed in the failed run:

```bash
cd /opt/apps/nabikaran
C="docker compose --env-file .env.production"
$C stop app cron
$C exec -T db psql -U nabikaran -d postgres -c "drop database nabikaran" -c "create database nabikaran owner nabikaran"
gunzip -c ~/backups/nabikaran/<file>.sql.gz | $C exec -T db psql -q -U nabikaran -d nabikaran
$C up -d
```

### One-time setup (about 10 minutes)

On the **VPS** (as the user that runs Docker, e.g. `root`):

```bash
cd /opt/apps/nabikaran && git pull            # makes sure deploy/deploy.sh exists
chmod +x deploy/deploy.sh deploy/ssh-deploy.sh
ssh-keygen -t ed25519 -N "" -C github-actions-deploy -f ~/nabikaran_actions
# Allow this key to do ONE thing: deploy. Paste as a single line:
echo "command=\"/opt/apps/nabikaran/deploy/ssh-deploy.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ~/nabikaran_actions.pub)" >> ~/.ssh/authorized_keys
cat ~/nabikaran_actions        # copy the PRIVATE key for the next step, then:
rm ~/nabikaran_actions ~/nabikaran_actions.pub
```

On **your computer** (to pin the server's identity):

```bash
ssh-keyscan -p 22 <VPS IP>     # copy all lines of output
```

In **GitHub → repository → Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | VPS IP or hostname |
| `DEPLOY_USER` | `root` (or the Docker user) |
| `DEPLOY_SSH_KEY` | the private key you copied (including the BEGIN/END lines) |
| `DEPLOY_KNOWN_HOSTS` | the `ssh-keyscan` output |
| `DEPLOY_PORT` | only if SSH is not on 22 |
| `DEPLOY_PATH` | only if the app is not in `/opt/apps/nabikaran` |

Optional: **Settings → Environments → production → Required reviewers** makes every deploy wait for your click.

Test it: **Actions → Deploy → Run workflow** (leave the commit empty to deploy the latest `main`). Until the secrets exist, the workflow skips itself with a notice.

Rules that keep auto-deploy safe:

- New environment variables (for example `WHATSAPP_*`) must be added to `.env.production` **before** merging the code that needs them; the deploy never edits that file.
- Do not edit tracked files on the server; the deploy refuses to overwrite them.
- To deploy an older commit, run the workflow by hand with that commit SHA.

## Before using production automation

The repository default branch at audit time is `claude/bold-brahmagupta-zglkbf`,
while production Actions target `main`. Explicitly clone `--branch main` for
production. Never assume a default-branch clone matches the release.
A successful SSH run on 2026-10-09 logged `recreating web (clone main, npm ci,
build)`, unlike the tracked Docker deploy script. Inspect the installed script,
containers, proxy, secrets policy and backups before reusing automation.
Do not overwrite the server script or trigger production deployment to resolve
this discrepancy. Establish private staging first.
