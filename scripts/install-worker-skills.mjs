#!/usr/bin/env node
/**
 * Install the factory's vendored WORKER skills (skills/worker/<name>/) into
 * the executing machine's skill directories for both worker CLI families:
 *
 *   ~/.claude/skills/<name>   (Claude Code)
 *   ~/.codex/skills/<name>    (Codex)
 *
 * Cross-platform (Node only — no pwsh/bash dependency) so the same script
 * provisions a Windows laptop, a teammate's mac, and the Docker image.
 * Idempotent: each destination skill dir is replaced wholesale, so edits to
 * the vendored source win on reinstall.
 *
 * Usage:
 *   node scripts/install-worker-skills.mjs [--home <dir>] [--dry-run]
 *
 * `--home` overrides the home directory (the Dockerfile passes the runtime
 * user's home explicitly so the build stage cannot install to root's).
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(repoRoot, 'skills', 'worker');

function parseArgs(argv) {
  const args = { home: homedir(), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home' && argv[i + 1] !== undefined) {
      args.home = resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--dry-run') {
      args.dryRun = true;
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      console.error('Usage: node scripts/install-worker-skills.mjs [--home <dir>] [--dry-run]');
      process.exit(2);
    }
  }
  return args;
}

async function listSkillDirs() {
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    // A worker skill is a directory carrying a SKILL.md; anything else
    // (docs, fixtures) is skipped loudly so a typo'd layout is noticed.
    try {
      await stat(join(sourceRoot, entry.name, 'SKILL.md'));
      dirs.push(entry.name);
    } catch {
      console.warn(`skip ${entry.name}: no SKILL.md`);
    }
  }
  return dirs;
}

const { home, dryRun } = parseArgs(process.argv.slice(2));
const skillNames = await listSkillDirs();

if (skillNames.length === 0) {
  console.log(`No worker skills found under ${sourceRoot} — nothing to install.`);
  process.exit(0);
}

const destinations = [join(home, '.claude', 'skills'), join(home, '.codex', 'skills')];

for (const destRoot of destinations) {
  for (const name of skillNames) {
    const source = join(sourceRoot, name);
    const dest = join(destRoot, name);
    if (dryRun) {
      console.log(`[dry-run] ${source} -> ${dest}`);
      continue;
    }
    await mkdir(destRoot, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(source, dest, { recursive: true });
    console.log(`installed ${name} -> ${dest}`);
  }
}

console.log(
  `${dryRun ? '[dry-run] Would install' : 'Installed'} ${skillNames.length} worker skill(s) ` +
    `for claude + codex under ${home}. ` +
    `Grant Claude access with SF_CLAUDE_ALLOWED_SKILLS=${skillNames.join(',')}`,
);
