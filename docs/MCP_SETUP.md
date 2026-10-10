# MCP setup in production: ChatGPT and Claude connectors

Nabikaran exposes a remote MCP server at **`https://mcp.nabikaran.org/mcp`**. A user connects it in ChatGPT or Claude, signs in with their phone number and OTP, approves the permissions, and can then manage their own reminders by chat. Design details are in `docs/MCP_ARCHITECTURE.md`; this file is the operational runbook for the `/docker/nabikaran` production stack (see `docs/DEPLOY_VPS.md`).

## 1. What a connected assistant can and cannot do

| Tool | Scope | Effect |
|---|---|---|
| `get_account` | `account:read` | Name, masked phone, language |
| `get_credit_balance` | `wallet:read` | Balance, reserved credits, top-up link |
| `list_reminders` | `reminders:read` | Reminders with schedule, message status, group and yearly flag |
| `list_groups` | `reminders:read` | The user's groups (e.g. "Friends' birthdays") |
| `prepare_reminder` | `reminders:write` | Resolves the date (BS/AD), message text, schedule and cost; saves nothing. Accepts `repeat_yearly` (birthdays, anniversaries) and `group_id` |
| `confirm_reminder` | `reminders:write` | Saves a prepared reminder and reserves its credits |
| `update_reminder` | `reminders:write` | Pause or resume (edits go through `prepare_reminder` with `reminder_id`) |
| `cancel_reminder` | `reminders:write` | Cancels with `confirm: true`; reserved credits are released |

Guarantees enforced on the server:

- **Confirmation before spending.** A reminder is only saved through `confirm_reminder` with the date that `prepare_reminder` returned, so the user has seen the message, date and cost.
- **All-or-nothing funding.** Same rule as the website. If the wallet cannot cover every message, nothing is saved. The tool returns `insufficient_credits` with the shortfall and `top_up_url`.
- **No money movement.** Assistants cannot top up, adjust credits or approve anything; top-ups happen only on the website.
- **Own number only.** Messages go only to the user's verified phone. Assistants cannot give WhatsApp consent.
- **Retry safe.** Repeating a confirm returns `replayed: true` and never creates a second reminder.
- **Revocable.** The user disconnects in **Settings → Connected apps**, and staff can disable a client in **Admin → Overview → OAuth / MCP clients**.

## 2. Server requirements (one time)

### 2.1 Environment variables

The web service in `/docker/nabikaran/docker-compose.yml` needs these three variables, next to `APP_URL`:

```yaml
      APP_URL: https://nabikaran.org
      MCP_HOST: mcp.nabikaran.org
      MCP_PUBLIC_URL: https://mcp.nabikaran.org/mcp
      OAUTH_ISSUER: https://nabikaran.org
```

| Variable | Why it matters |
|---|---|
| `MCP_PUBLIC_URL` | The token audience (`resource`). If unset, the app falls back to `http://localhost:3000/mcp`; ChatGPT then gets tokens that do not match, and every tool call fails. |
| `MCP_HOST` | Serves `/` on `mcp.nabikaran.org` as the MCP endpoint. Applied at build time, so the web container must be rebuilt after setting it. |
| `OAUTH_ISSUER` | Issuer in the OAuth metadata. Falls back to `APP_URL`, but should be set explicitly. |

### 2.2 Traefik route

`n8n-traefik-1` must route `mcp.nabikaran.org` to the same web service. Add a router next to the existing `nabikaran` router labels:

```yaml
      - traefik.http.routers.nabikaran-mcp.rule=Host(`mcp.nabikaran.org`)
      - traefik.http.routers.nabikaran-mcp.entrypoints=websecure
      - traefik.http.routers.nabikaran-mcp.service=nabikaran
      - traefik.http.routers.nabikaran-mcp.tls.certresolver=mytlschallenge
```

Use the same label style (list or map) as the existing ones. The certificate is issued on the first HTTPS request, which can take 1–2 minutes.

### 2.3 DNS

An `A` record for `mcp` pointing to the VPS IP (`69.62.75.166`).

### 2.4 Applying the change safely

```bash
cp /docker/nabikaran/docker-compose.yml /root/backups/nabikaran/docker-compose.yml.bak-$(date +%F-%H%M)
nano /docker/nabikaran/docker-compose.yml   # or edit the stack in hPanel → VPS → Docker Manager
docker compose --project-directory /docker/nabikaran -f /docker/nabikaran/docker-compose.yml config -q && echo "YAML OK"
bash /root/nabikaran-deploy.sh               # rebuilds web; the site is down for a few minutes
```

To undo, copy the newest `docker-compose.yml.bak-*` back and run the deploy script again.

## 3. Verify

```bash
dig +short mcp.nabikaran.org
docker exec nabikaran-web-1 printenv MCP_HOST MCP_PUBLIC_URL OAUTH_ISSUER
docker inspect nabikaran-web-1 --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' | grep 'routers.nabikaran-mcp'
curl -s https://mcp.nabikaran.org/.well-known/oauth-protected-resource; echo
curl -s https://nabikaran.org/.well-known/oauth-authorization-server | head -c 300; echo
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.nabikaran.org/mcp
```

| Check | Expected |
|---|---|
| DNS | the VPS IP |
| `printenv` | `mcp.nabikaran.org`, `https://mcp.nabikaran.org/mcp`, `https://nabikaran.org` |
| Router labels | four `routers.nabikaran-mcp.*` lines |
| Protected resource | `"resource":"https://mcp.nabikaran.org/mcp"`, `authorization_servers` = `https://nabikaran.org` |
| Authorization server | `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint` on `https://nabikaran.org` |
| `/mcp` without a token | `401` (correct; the response carries `WWW-Authenticate` pointing to the metadata) |

Troubleshooting:

| Symptom | Cause | Fix |
|---|---|---|
| `/mcp` returns `000` | No Traefik router for `mcp.nabikaran.org`, or the certificate is not issued yet | Check §2.2; wait 2 minutes; `docker logs --since 10m n8n-traefik-1 2>&1 \| grep -i nabikaran` |
| `resource` shows `localhost` | `MCP_PUBLIC_URL` missing | Set it (§2.1) and redeploy |
| `mcp.nabikaran.org/` shows the website, not 401 | `MCP_HOST` missing at build time | Set it and redeploy |
| ChatGPT says authorization failed after OTP | `resource` or issuer mismatch | Re-run §3; both URLs must be HTTPS on the real domains |
| Tool calls fail with `rate_limited` | Per-client limits | Wait a minute; see `docs/OPERATIONS.md` §6 |

## 4. Connect ChatGPT

Custom connectors need ChatGPT **Developer mode**. Its availability and menu names depend on the plan and change over time.

1. **Settings → Apps & Connectors → Advanced settings → Developer mode**: on.
2. **Create** a connector:
   - Name: `Nabikaran`
   - Description: `Nepal renewal reminders by SMS and WhatsApp`
   - MCP server URL: `https://mcp.nabikaran.org/mcp`
   - Authentication: **OAuth**
3. ChatGPT registers itself and opens `nabikaran.org/login`. Enter the phone number and OTP, read the consent page, then **Allow**.
4. In a new chat, enable Nabikaran from the **+ → Developer mode** menu.

**Claude:** Settings → Connectors → **Add custom connector** → the same URL. The OAuth flow is the same.

## 5. Acceptance test

Run with a real staff account, and record the transcript as evidence.

| # | Prompt | Expected |
|---|---|---|
| 1 | "Mero Nabikaran balance kati chha?" | `get_credit_balance`; balance and top-up link |
| 2 | "List my Nabikaran reminders." | `list_reminders` |
| 3 | "Mero bluebook 2083-03-15 BS ma expire hunchha, 7 din ra 1 din agadi SMS pathau." | `prepare_reminder`; the assistant shows the AD date, message text and cost, and asks to confirm |
| 4 | "Ho, confirm." | `confirm_reminder`. With enough credits, the reminder is saved and credits are reserved (visible in Wallet). Without, `insufficient_credits` with the shortfall and top-up link, and nothing is saved. |
| 5 | Repeat the confirmation | `replayed: true`; still one reminder |
| 6 | "Tyo 3 din agadi matra banau." | `prepare_reminder` with `reminder_id`, then confirm; reservations adjusted |
| 7 | "Cancel garde." | `cancel_reminder` with confirmation; credits released |
| 8 | Disconnect in **Settings → Connected apps**, then ask again | 401; ChatGPT asks to sign in again |
| 9 | A second account asks for reminders | Sees only its own |
| 10 | "Mero sathi Ram Sharma ko birthday Shrawan 15 (BS) ho, Friends' birthdays group ma rakha" | `list_groups`, then `prepare_reminder` with `category: birthday`, `repeat_yearly: true`, `group_id`; the prompt says it repeats every year and the SMS goes only to the user |

Steps 3–7 use real credits in production, so use a staff account and cancel afterwards.

## 6. Monitoring

The **Production check** workflow (`.github/workflows/prod-check.yml`) runs after every deploy and every 30 minutes. It fails, and GitHub emails the repository owner, when `mcp.nabikaran.org` stops returning the protected-resource metadata or `/mcp` stops answering 401 without a token.


- **Admin → Overview → AI assistants (MCP):**
  - connected users;
  - tool calls and errors (24 h);
  - unauthorized calls;
  - prepared vs confirmed actions.
- **Admin → Overview → OAuth / MCP clients:** registered clients, live tokens, and the kill switch per client.
- **Logs:**

  ```bash
  docker logs --since 1h nabikaran-web-1 2>&1 | grep -iE "mcp|oauth" | tail -50
  ```

## 7. Publishing to the directories

When the acceptance test has passed on production, the connector can be submitted to the ChatGPT apps directory and the Claude connectors directory (`docs/LAUNCH_CHECKLIST.md` E6). Before submitting, confirm:

- Privacy and Terms mention connected apps;
- `LEGAL_*` and `SUPPORT_*` are set;
- the support email is monitored.
