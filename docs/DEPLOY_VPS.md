# Deploying Nabikaran on a Hostinger VPS (Docker)

Target: a VPS that already runs other projects in Docker behind a reverse proxy. Nabikaran adds four containers (`db`, `migrate`, `app`, `cron`) on its own internal network and is reached only through your existing proxy. Nothing else on the server is touched.

Requirements: Ubuntu 22.04/24.04 VPS, Docker Engine + Compose plugin, ≥ 2 GB RAM (the Next build needs ~1.5 GB briefly; add swap if you have 1–2 GB), two DNS records.

## 1. DNS (Hostinger hPanel → Domains → nabikaran.org → DNS)

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

Then: open `https://nabikaran.org/login`, enter your number; with `SMS_PROVIDER=mock` the OTP is printed in `docker compose logs app` (and shown on the page). Make yourself admin:

```bash
docker compose --env-file .env.production exec db psql -U nabikaran -d nabikaran -c "update users set role='admin' where phone_e164='+977XXXXXXXXXX';"
```

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

## Prompt for Claude for Chrome

Claude for Chrome works in your browser, so it can handle the Hostinger hPanel parts (DNS) and, if you use Hostinger's **Browser terminal** or Nginx Proxy Manager's web UI, the server parts too. Paste this, filling the placeholders:

```
You are helping me deploy a Next.js app called Nabikaran to my Hostinger VPS, which already runs other Docker projects behind <Nginx Proxy Manager | Traefik | Caddy | Nginx>. Work step by step, show me each command or form before submitting it, and stop and ask me if anything looks different from what you expect. Never print or paste secrets into chat; keep them only in the terminal.

Facts:
- VPS IPv4: <IP>
- Domain: nabikaran.org (DNS managed in Hostinger hPanel)
- Repo: https://github.com/digitalsolution2078/nabikaran (branch main)
- Deployment guide to follow: docs/DEPLOY_VPS.md in that repo
- Reverse proxy in use: <...>; it listens on 80/443 and <runs in Docker on network "<name>" | runs on the host>

Steps:
1. In Hostinger hPanel → Domains → nabikaran.org → DNS, create A records for @, www and mcp pointing to the VPS IP (TTL 300). Confirm each record after saving.
2. Open the VPS terminal (hPanel → VPS → Browser terminal, or tell me to SSH). Run the commands in guide section 2: clone into /opt/apps/nabikaran, copy .env.production.example to .env.production, generate four secrets with openssl and put them in the file with nano, chmod 600.
3. Run section 3: docker compose --env-file .env.production up -d --build, then `ps` and wait until migrate has exited 0 and app is up. Show me the output of curl http://127.0.0.1:3100/api/health.
4. Configure the reverse proxy per section 4 for the hosts nabikaran.org + www.nabikaran.org and mcp.nabikaran.org with HTTPS certificates. If it is Nginx Proxy Manager, do it in its web UI and enable Websockets support and Force SSL.
5. Run the verification curls in section 5 and report the results. Then open https://nabikaran.org/login, request an OTP for my number, read the code from `docker compose logs app`, log in, and tell me when the dashboard loads.
6. Run the admin SQL from section 5 for my phone number <+977...>, then open https://nabikaran.org/admin and confirm the "Scheduler health" notice is gone after two minutes.
Do not change SMS_PROVIDER or PAYMENT_GATEWAY from mock, and do not touch any other container on the server.
```
