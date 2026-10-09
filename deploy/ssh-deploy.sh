#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key (repo-compose layout, docs/DEPLOY_VPS.md §7):
#   command="/opt/apps/nabikaran/deploy/ssh-deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy
# Whatever the client asks to run, this key can only deploy a commit of origin/main.
set -euo pipefail
REQ="${SSH_ORIGINAL_COMMAND:-}"
SHA="${REQ##* }"                      # last word of the request
if [[ -n "$SHA" && ! "$SHA" =~ ^[0-9a-f]{7,40}$ ]]; then SHA=""; fi
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" ${SHA:+"$SHA"}
