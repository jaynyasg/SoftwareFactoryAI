#!/usr/bin/env pwsh
#
# Thin Codex wrapper for the Software Factory CLI (Windows/PowerShell).
#
# It forwards to the `software-factory` CLI with `--caller-family codex` and does
# NOT implement any factory logic itself (no supervisor, worker runner, ledger, or
# packager — the CLI + local backend own all of that). Output contract and usage
# are documented in ../SKILL.md.
#
# All passthrough arguments are captured in $Args.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-RepoRoot {
  param([string]$Path)
  return (
    (Test-Path (Join-Path $Path 'pnpm-workspace.yaml')) -and
    (Test-Path (Join-Path $Path 'packages\cli\src\index.ts'))
  )
}

function Resolve-RepoRoot {
  if ($env:SOFTWARE_FACTORY_REPO_ROOT -and (Test-RepoRoot $env:SOFTWARE_FACTORY_REPO_ROOT)) {
    return (Resolve-Path $env:SOFTWARE_FACTORY_REPO_ROOT).Path
  }

  $localCandidate = Resolve-Path (Join-Path $ScriptDir '..\..\..') -ErrorAction SilentlyContinue
  if ($localCandidate -and (Test-RepoRoot $localCandidate.Path)) {
    return $localCandidate.Path
  }

  $marker = Join-Path $ScriptDir 'repo-root.txt'
  if (Test-Path $marker) {
    $marked = (Get-Content $marker -Raw).Trim()
    if ($marked -and (Test-RepoRoot $marked)) {
      return (Resolve-Path $marked).Path
    }
  }

  $dir = (Get-Location).Path
  for ($i = 0; $i -lt 10; $i += 1) {
    if (Test-RepoRoot $dir) {
      return (Resolve-Path $dir).Path
    }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir -or -not $parent) {
      break
    }
    $dir = $parent
  }

  throw 'Could not locate the Software Factory repo. Set SOFTWARE_FACTORY_REPO_ROOT to the repo root.'
}

function Test-RemoteBaseUrl {
  if (-not $env:SF_BASE_URL) {
    return $false
  }
  try {
    $uri = [Uri]$env:SF_BASE_URL
    return -not @('127.0.0.1', 'localhost', '[::1]', '::1').Contains($uri.Host)
  }
  catch {
    return $false
  }
}

$RepoRoot = Resolve-RepoRoot
$CliEntry = Join-Path $RepoRoot 'packages\cli\src\index.ts'

# Run the CLI through the repo's tsx (no global install needed). Prefer the pnpm
# .bin shim so the caller's working directory is preserved (relative PRD paths
# keep working); fall back to `node --import tsx`.
function Invoke-Cli {
  param([string[]]$CliArgs)
  $TsxCmd = Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'
  if (Test-Path $TsxCmd) {
    & $TsxCmd $CliEntry @CliArgs
  }
  else {
    & node --import tsx $CliEntry @CliArgs
  }
}

# Ensure a backend is up (connect if reachable, else boot a standalone one).
# Best-effort: never block the actual command on start hiccups. Output -> stderr.
try {
  $startArgs = @('start', '--json')
  if (Test-RemoteBaseUrl) {
    $startArgs += '--no-spawn'
  }
  Invoke-Cli $startArgs 2>&1 | ForEach-Object { [Console]::Error.WriteLine($_) }
}
catch {
  # ignore: the command below will surface a clear error if no backend is reachable
}

$known = @('start', 'run', 'status', 'events', 'artifacts', 'help', '--help')
$argList = @($Args)
$first = if ($argList.Count -gt 0) { [string]$argList[0] } else { '' }

if ($known -contains $first) {
  $cmd = $first
  $rest = if ($argList.Count -gt 1) { $argList[1..($argList.Count - 1)] } else { @() }
}
else {
  $cmd = 'run' # a bare prompt (or leading flag) is treated as a run
  $rest = $argList
}

if ($cmd -eq 'run') {
  Invoke-Cli (@('run') + $rest + @('--caller-family', 'codex'))
}
else {
  Invoke-Cli (@($cmd) + $rest)
}

exit $LASTEXITCODE
