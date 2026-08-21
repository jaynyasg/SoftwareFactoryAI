#!/usr/bin/env pwsh
#
# Install the repo-local Software Factory skills into the user's Codex and
# Claude skill roots. The installed wrappers keep a repo-root marker so they can
# run the CLI even when invoked from the global skill directory.
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Install-FactorySkill {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force

  $ScriptDir = Join-Path $Destination 'scripts'
  New-Item -ItemType Directory -Force -Path $ScriptDir | Out-Null
  Set-Content -Path (Join-Path $ScriptDir 'repo-root.txt') -Value $RepoRoot -Encoding utf8
}

$CodexDestination = Join-Path $HOME '.codex\skills\software-factory-codex'
$ClaudeDestination = Join-Path $HOME '.claude\skills\software-factory-claude'

Install-FactorySkill -Source (Join-Path $RepoRoot 'skills\codex') -Destination $CodexDestination
Install-FactorySkill -Source (Join-Path $RepoRoot 'skills\claude') -Destination $ClaudeDestination

Write-Output "Installed software-factory-codex -> $CodexDestination"
Write-Output "Installed software-factory-claude -> $ClaudeDestination"
Write-Output "Repo root marker -> $RepoRoot"
