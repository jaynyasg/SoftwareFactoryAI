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
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
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
run_cli start --json 1>&2 || true

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
