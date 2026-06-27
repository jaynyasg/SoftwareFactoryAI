/**
 * Package a generated-app directory as a VALID Git repo.
 *
 * Steps, in order:
 *   1. write the factory metadata files into the app dir:
 *        - `PROVENANCE.json`        — the provenance bundle,
 *        - `HANDOFF.md`             — the human handoff,
 *        - `.env.example`           — env example (when provided),
 *        - `.factory/run-ledger.jsonl` — a ledger excerpt,
 *        - `.factory/tests-summary.md` — the gates/tests summary (when provided),
 *        - `.factory/README.md`     — a packaging README;
 *   2. `git init`, `git add -A`, `git commit` (with an explicit author so the
 *      commit succeeds unattended), then `git rev-parse HEAD` to read the commit —
 *      ALL through the injected `CommandRunner`, so tests use a fake git;
 *   3. emit `package.created` with the repo path + handoff pointer.
 *
 * Returns a repo artifact descriptor (path, commit, branch, files written). File
 * writes use `node:fs/promises` by default (real temp-dir testing) but the seams
 * are injectable.
 */
import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AppendableEvent,
  CommandRunner,
  EventActor,
  EventStore,
  FactoryEvent,
  ProvenanceBundle,
} from '@software-factory/core';

/** A file the packager writes, by repo-relative path + content. */
export interface PackagedFile {
  readonly path: string;
  readonly content: string;
}

/** The author used for the factory commit (so it never blocks on git config). */
export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

/** Parameters for `packageRepo`. */
export interface RepoPackagerParams {
  readonly runId: string;
  readonly ticketId?: string;
  readonly artifactId: string;
  /** Absolute path to the generated-app directory to package. */
  readonly repoDir: string;
  readonly provenance: ProvenanceBundle;
  readonly handoffMarkdown: string;
  /** Ledger events to write as `.factory/run-ledger.jsonl` (one JSON per line). */
  readonly ledgerExcerpt: readonly FactoryEvent[];
  readonly envExample?: string;
  readonly testsSummaryMarkdown?: string;
  /** Extra files to write (repo-relative paths). */
  readonly extraFiles?: readonly PackagedFile[];
  readonly commitMessage?: string;
  readonly author?: CommitAuthor;
  /** Disable GPG signing for this unattended, throwaway commit (default true). */
  readonly disableGpgSign?: boolean;
  readonly summary?: string;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
}

/** The packaged repo artifact descriptor. */
export interface RepoArtifactDescriptor {
  readonly path: string;
  readonly commit: string;
  readonly branch: string;
  /** Repo-relative paths of the metadata files written by the packager. */
  readonly files: readonly string[];
}

/** Injectable filesystem seams (default `node:fs/promises`). */
export interface RepoPackagerDeps {
  readonly store: EventStore;
  readonly runner: CommandRunner;
  readonly writeFile?: (path: string, content: string) => Promise<void>;
  readonly mkdir?: (path: string) => Promise<void>;
}

const DEFAULT_AUTHOR: CommitAuthor = {
  name: 'Software Factory',
  email: 'factory@software-factory.local',
};
const DEFAULT_BRANCH = 'main';

function packagingReadme(params: RepoPackagerParams): string {
  const dest = params.provenance.gitDestination;
  const ownership = dest === undefined ? 'unset' : dest.temporary ? 'factory-owned temporary' : 'user-provided';
  return [
    `# Packaged by the Software Factory`,
    '',
    `- Run: \`${params.runId}\``,
    `- Artifact: \`${params.artifactId}\``,
    `- Git ownership: ${ownership}`,
    '',
    'This repository was packaged from a generated app. See `HANDOFF.md` for how',
    'to run it and `PROVENANCE.json` for full build provenance (source, ticket',
    'plan, events, gate evidence, generated files, dependency decisions, preview,',
    'deploy config, and artifact confidence).',
    '',
  ].join('\n');
}

/**
 * Package the app directory as a committed Git repo and emit `package.created`.
 * Git operations go through the injected runner, so failures surface as thrown,
 * observable errors (never silently swallowed).
 */
export async function packageRepo(
  params: RepoPackagerParams,
  deps: RepoPackagerDeps,
): Promise<RepoArtifactDescriptor> {
  const writeFile = deps.writeFile ?? ((path, content) => fsWriteFile(path, content, 'utf8'));
  const mkdir = deps.mkdir ?? ((path) => fsMkdir(path, { recursive: true }).then(() => undefined));
  const author = params.author ?? DEFAULT_AUTHOR;
  const disableGpgSign = params.disableGpgSign ?? true;

  // 1. Assemble the metadata files (repo-relative path -> content).
  const ledgerJsonl = `${params.ledgerExcerpt.map((event) => JSON.stringify(event)).join('\n')}\n`;
  const files: PackagedFile[] = [
    { path: 'PROVENANCE.json', content: `${JSON.stringify(params.provenance, null, 2)}\n` },
    { path: 'HANDOFF.md', content: params.handoffMarkdown },
    { path: '.factory/run-ledger.jsonl', content: ledgerJsonl },
    { path: '.factory/README.md', content: packagingReadme(params) },
  ];
  if (params.envExample !== undefined) {
    files.push({ path: '.env.example', content: params.envExample });
  }
  if (params.testsSummaryMarkdown !== undefined) {
    files.push({ path: '.factory/tests-summary.md', content: params.testsSummaryMarkdown });
  }
  if (params.extraFiles !== undefined) {
    files.push(...params.extraFiles);
  }

  // Write each file, creating parent dirs as needed.
  await mkdir(params.repoDir);
  for (const file of files) {
    const absolute = join(params.repoDir, file.path);
    const parent = dirname(absolute);
    if (parent !== params.repoDir) {
      await mkdir(parent);
    }
    await writeFile(absolute, file.content);
  }

  // 2. init -> add -> commit -> read commit, all through the runner.
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await deps.runner.run('git', args, {
      cwd: params.repoDir,
      signal: params.signal,
    });
    if (result.code !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed in ${params.repoDir} (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    return result.stdout;
  };

  await git(['init', '-b', DEFAULT_BRANCH]);
  await git(['add', '-A']);
  const commitArgs = [
    '-c',
    `user.name=${author.name}`,
    '-c',
    `user.email=${author.email}`,
    ...(disableGpgSign ? ['-c', 'commit.gpgsign=false'] : []),
    'commit',
    '-m',
    params.commitMessage ?? `Package ${params.artifactId} (run ${params.runId})`,
  ];
  await git(commitArgs);
  const commit = (await git(['rev-parse', 'HEAD'])).trim();

  // 3. Record the package on the ledger.
  const writtenPaths = files.map((file) => file.path);
  const actor: EventActor = { kind: 'system', id: 'repo-packager', display: 'repo-packager' };
  await deps.store.append({
    runId: params.runId,
    ticketId: params.ticketId,
    type: 'package.created',
    actor,
    subject: { kind: 'artifact', id: params.artifactId },
    severity: 'success',
    timestamp: params.clock?.(),
    evidence: [
      { label: 'repo', ref: params.repoDir, note: `commit ${commit}` },
      { label: 'provenance', ref: 'PROVENANCE.json' },
    ],
    payload: {
      repoPath: params.repoDir,
      handoffRef: 'HANDOFF.md',
      summary:
        params.summary ?? `Packaged ${params.artifactId} as a git repo at commit ${commit}.`,
    },
  } as AppendableEvent);

  return { path: params.repoDir, commit, branch: DEFAULT_BRANCH, files: writtenPaths };
}
