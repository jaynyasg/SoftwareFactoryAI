/**
 * Secret-scan gate: scans workspace file CONTENTS for committed secrets and fails
 * (blocking) with the offending locations as evidence.
 *
 * It detects private keys, cloud/provider API keys, VCS tokens, and `.env`-style
 * secret assignments. The file source is injectable (`WorkspaceFiles`) so the
 * scan is unit-tested against in-memory fixture contents with no real filesystem;
 * the default reads text files under the workspace (skipping vendored / build
 * dirs). Matched secrets are REDACTED in evidence so the scan never echoes the
 * secret it found.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Gate, GateContext, GateEvidence, GateResult } from './command-gate';

/** An injectable workspace file source (list + read text). */
export interface WorkspaceFiles {
  list(): Promise<readonly string[]>;
  read(path: string): Promise<string>;
}

/** One detected secret occurrence. */
export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  /** The matched line with the secret redacted. */
  readonly excerpt: string;
}

/** A named secret-detection rule. */
export interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
}

/** The built-in secret-detection rules (extensible by callers). */
export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai-api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: 'secret-assignment',
    pattern:
      /\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
  {
    id: 'env-secret',
    pattern: /^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)\s*=\s*\S{6,}/,
  },
];

/** Directory names skipped by the default filesystem file source. */
export const DEFAULT_SCAN_IGNORE_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
];

/** Redact the middle of a secret so evidence never echoes it in full. */
export function redactSecret(secret: string): string {
  if (secret.length <= 8) {
    return '*'.repeat(secret.length);
  }
  return `${secret.slice(0, 3)}…${secret.slice(-2)}[redacted]`;
}

/** Scan one file's contents for secrets; returns findings with line numbers. */
export function scanContentForSecrets(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(line);
      if (match) {
        const redacted = line.replace(match[0], redactSecret(match[0])).trim().slice(0, 200);
        findings.push({ file, line: index + 1, rule: rule.id, excerpt: redacted });
      }
    }
  }
  return findings;
}

/** Build an in-memory workspace file source from a `path -> contents` map. */
export function createInMemoryWorkspaceFiles(
  files: Readonly<Record<string, string>>,
): WorkspaceFiles {
  return {
    list(): Promise<readonly string[]> {
      return Promise.resolve(Object.keys(files));
    },
    read(path: string): Promise<string> {
      return Promise.resolve(files[path] ?? '');
    },
  };
}

/** Build a filesystem-backed workspace file source rooted at `root`. */
export function createFsWorkspaceFiles(
  root: string,
  ignoreDirs: readonly string[] = DEFAULT_SCAN_IGNORE_DIRS,
): WorkspaceFiles {
  const ignore = new Set(ignoreDirs);

  async function walk(dir: string, acc: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) {
          continue;
        }
        await walk(join(dir, entry.name), acc);
      } else if (entry.isFile()) {
        acc.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
      }
    }
  }

  return {
    async list(): Promise<readonly string[]> {
      const acc: string[] = [];
      await walk(root, acc);
      return acc;
    },
    read(path: string): Promise<string> {
      return readFile(join(root, path), 'utf8');
    },
  };
}

/** Options for the secret-scan gate. */
export interface SecretScanGateOptions {
  /** Injectable file source (defaults to a filesystem source over the workspace). */
  readonly files?: WorkspaceFiles;
}

function findingsToEvidence(findings: readonly SecretFinding[]): GateEvidence[] {
  return findings.map((finding) => ({
    label: `secret:${finding.rule}`,
    detail: `${finding.file}:${finding.line}`,
    outputExcerpt: finding.excerpt,
  }));
}

/** Create the secret-scan gate. */
export function createSecretScanGate(options: SecretScanGateOptions = {}): Gate {
  return {
    name: 'secret-scan',
    async run(ctx: GateContext): Promise<GateResult> {
      const files = options.files ?? createFsWorkspaceFiles(ctx.workspaceDir);
      const paths = await files.list();
      const findings: SecretFinding[] = [];
      for (const path of paths) {
        const content = await files.read(path);
        findings.push(...scanContentForSecrets(path, content));
      }

      if (findings.length === 0) {
        return {
          gate: 'secret-scan',
          passed: true,
          summary: `No secrets detected across ${paths.length} file(s).`,
          evidence: [{ label: 'secret-scan', detail: `${paths.length} file(s) scanned` }],
        };
      }

      const locations = findings.map((f) => `${f.file}:${f.line} (${f.rule})`).join(', ');
      return {
        gate: 'secret-scan',
        passed: false,
        reason: `Detected ${findings.length} potential secret(s): ${locations}.`,
        outputExcerpt: findings
          .map((f) => `${f.file}:${f.line} ${f.excerpt}`)
          .join('\n')
          .slice(0, 600),
        evidence: findingsToEvidence(findings),
      };
    },
  };
}
