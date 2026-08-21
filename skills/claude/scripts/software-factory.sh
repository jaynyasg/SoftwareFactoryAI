#!/usr/bin/env bash
#
# Thin Claude wrapper for the Software Factory CLI.
#
# It forwards to the `software-factory` CLI with `--caller-family claude` and does
# NOT implement any factory logic itself (no supervisor, worker runner, ledger, or
# packager — the CLI + local backend own all of that). Output contract and usage
# are documented in ../SKILL.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

is_repo_root() {
  [ -f "$1/pnpm-workspace.yaml" ] && [ -f "$1/packages/cli/src/index.ts" ]
}

resolve_repo_root() {
  if [ -n "${SOFTWARE_FACTORY_REPO_ROOT:-}" ] && is_repo_root "$SOFTWARE_FACTORY_REPO_ROOT"; then
    cd "$SOFTWARE_FACTORY_REPO_ROOT" && pwd
    return
  fi

  local local_candidate
  local_candidate="$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd || true)"
  if [ -n "$local_candidate" ] && is_repo_root "$local_candidate"; then
    echo "$local_candidate"
    return
  fi

  local marker="$SCRIPT_DIR/repo-root.txt"
  if [ -f "$marker" ]; then
    local marked
    marked="$(tr -d '\r\n' < "$marker")"
    if [ -n "$marked" ] && is_repo_root "$marked"; then
      cd "$marked" && pwd
      return
    fi
  fi

  local dir
  dir="$(pwd)"
  while [ "$dir" != "/" ]; do
    if is_repo_root "$dir"; then
      echo "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done

  echo "Could not locate the Software Factory repo. Set SOFTWARE_FACTORY_REPO_ROOT to the repo root." >&2
  return 1
}

is_remote_base_url() {
  case "${SF_BASE_URL:-}" in
    "" | http://127.0.0.1:* | http://localhost:* | http://[::1]:*)
      return 1
      ;;
    http://* | https://*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

REPO_ROOT="$(resolve_repo_root)"
CLI_ENTRY="$REPO_ROOT/packages/cli/src/index.ts"

# Run the CLI through the repo's tsx (no global install needed). Prefer the pnpm
# .bin shim so the caller's working directory is preserved (relative PRD paths
# keep working); fall back to `node --import tsx`.
run_cli() {
  local tsx_bin="$REPO_ROOT/node_modules/.bin/tsx"
  if [ -x "$tsx_bin" ]; then
    "$tsx_bin" "$CLI_ENTRY" "$@"
  else
    node --import tsx "$CLI_ENTRY" "$@"
  fi
}

# Ensure a backend is up (connect if reachable, else boot a standalone one).
# Best-effort: never block the actual command on start hiccups. Output -> stderr.
start_args=(start --json)
if is_remote_base_url; then
  start_args+=(--no-spawn)
fi
run_cli "${start_args[@]}" 1>&2 || true

first="${1:-}"
case "$first" in
  start | run | status | events | artifacts | help | --help)
    cmd="$first"
    shift
    ;;
  *)
    cmd="run" # a bare prompt (or leading flag) is treated as a run
    ;;
esac

if [ "$cmd" = "run" ]; then
  exec_args=(run "$@" --caller-family claude)
else
  exec_args=("$cmd" "$@")
fi

tsx_bin="$REPO_ROOT/node_modules/.bin/tsx"
if [ -x "$tsx_bin" ]; then
  exec "$tsx_bin" "$CLI_ENTRY" "${exec_args[@]}"
else
  exec node --import tsx "$CLI_ENTRY" "${exec_args[@]}"
fi
