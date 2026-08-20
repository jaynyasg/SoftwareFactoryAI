#!/bin/sh
# Container entrypoint: best-effort headless worker-CLI auth + loud boot
# diagnostics, then the web server. Every check here is advisory — the factory
# itself fails closed (preflight + setup checklist) when an adapter is not
# ready, so this script only makes the boot log explain WHY.
set -eu

log() { echo "[software-factory entrypoint] $1"; }

# Ledger dir must be writable (Render mounts the persistent disk at /var/data).
if [ -n "${SF_FACTORY_DIR:-}" ]; then
  if mkdir -p "$SF_FACTORY_DIR" 2>/dev/null; then
    log "ledger dir ready: $SF_FACTORY_DIR"
  else
    log "ERROR: cannot create SF_FACTORY_DIR=$SF_FACTORY_DIR (disk mount permissions?)"
  fi
fi

# Claude Code: authenticates headless via ANTHROPIC_API_KEY or a long-lived
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token` on any machine).
if command -v claude >/dev/null 2>&1; then
  log "claude CLI: $(claude --version 2>/dev/null || echo 'version probe failed')"
  if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    log "claude auth: credential env var present"
  else
    log "claude auth: NO ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — adapter will report unauthenticated"
  fi
else
  log "claude CLI: not installed"
fi

# Codex: `login status` reads stored credentials, so an API key must be turned
# into a login once per container filesystem. Try the current flag first, then
# the older stdin form — codex CLI auth flags have moved across versions.
if command -v codex >/dev/null 2>&1; then
  log "codex CLI: $(codex --version 2>/dev/null || echo 'version probe failed')"
  if codex login status >/dev/null 2>&1; then
    log "codex auth: already logged in"
  elif [ -n "${OPENAI_API_KEY:-}" ]; then
    if codex login --api-key "$OPENAI_API_KEY" >/dev/null 2>&1; then
      log "codex auth: logged in with OPENAI_API_KEY (--api-key)"
    elif printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null 2>&1; then
      log "codex auth: logged in with OPENAI_API_KEY (--with-api-key)"
    else
      log "codex auth: API-key login FAILED — adapter will report unauthenticated"
    fi
  else
    log "codex auth: not logged in and no OPENAI_API_KEY — adapter will report unauthenticated"
  fi
else
  log "codex CLI: not installed"
fi

if [ "$#" -eq 0 ]; then
  # Exec the next binary directly: `pnpm run start -- -H ...` forwards the
  # `--` to `next start`, which then misreads `-H` as a project directory.
  cd /app/packages/web
  exec ./node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
fi
exec "$@"
