/**
 * Genome module registry: lookup of module contracts by id (and id+version).
 *
 * Two construction paths share one read API:
 *  - `createModuleRegistry(contracts)` builds an in-memory registry (tests, or
 *    callers that already hold validated contracts), and
 *  - `loadModuleRegistry(genomeDir)` reads + validates a genome directory from
 *    disk (a `factory.json` manifest plus the module files it references).
 *
 * The genome directory is always an explicit PARAMETER — there is no magic path
 * resolution. `resolveGenomeDir` is offered only as a convenience for callers
 * that want the conventional layout.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseModuleContract } from './module-contract';
import type { ModuleContract } from './module-contract';

/** Conventional genome version directory name. */
export const DEFAULT_GENOME_VERSION = 'v1';

/** Conventional top-level genome directory name. */
export const GENOME_DIRNAME = 'factory-genome';

/** Manifest file name within a genome version directory. */
export const GENOME_MANIFEST_FILENAME = 'factory.json';

/** The parsed `factory.json` manifest. */
export interface GenomeManifest {
  /** Genome version label (e.g. `v1`). */
  readonly version: string;
  /** Ordered module-id pipeline. */
  readonly pipeline: readonly string[];
  /** Module file references, relative to the genome directory. */
  readonly modules: readonly string[];
}

/** A registry plus the manifest and directory it was loaded from. */
export interface LoadedGenome {
  readonly genomeDir: string;
  readonly manifest: GenomeManifest;
  readonly registry: ModuleRegistry;
}

/** Read API over a set of versioned module contracts. */
export interface ModuleRegistry {
  /** Every contract (all versions), sorted by id then version. */
  list(): ModuleContract[];
  /** Distinct module ids, sorted. */
  ids(): string[];
  /** Whether any version of `id` exists. */
  has(id: string): boolean;
  /** The latest version of `id`, or `undefined`. */
  get(id: string): ModuleContract | undefined;
  /** A specific `id`@`version`, or `undefined`. */
  getVersion(id: string, version: string): ModuleContract | undefined;
  /** Known versions of `id`, sorted ascending. */
  versions(id: string): string[];
}

/** Raised when a genome directory cannot be loaded or is inconsistent. */
export class GenomeLoadError extends Error {
  readonly code = 'genome_load_failed';
  constructor(
    message: string,
    readonly source?: string,
  ) {
    super(source !== undefined ? `${message} (${source})` : message);
    this.name = 'GenomeLoadError';
  }
}

/** Raised when a registry would contain two contracts with the same id+version. */
export class DuplicateModuleError extends Error {
  readonly code = 'duplicate_module';
  constructor(
    readonly id: string,
    readonly version: string,
  ) {
    super(`Duplicate module contract for ${id}@${version}.`);
    this.name = 'DuplicateModuleError';
  }
}

/** Join the conventional genome path under a repo root (pure; no I/O). */
export function resolveGenomeDir(
  repoRoot: string,
  version: string = DEFAULT_GENOME_VERSION,
): string {
  return join(repoRoot, GENOME_DIRNAME, version);
}

/** Compare dotted numeric versions, falling back to lexical order. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const length = Math.max(pa.length, pb.length);
  for (let index = 0; index < length; index += 1) {
    const x = Number.parseInt(pa[index] ?? '0', 10);
    const y = Number.parseInt(pb[index] ?? '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (x !== y) {
      return x - y;
    }
  }
  return 0;
}

/** Build an in-memory registry from already-validated contracts. */
export function createModuleRegistry(contracts: readonly ModuleContract[]): ModuleRegistry {
  const byId = new Map<string, Map<string, ModuleContract>>();
  for (const contract of contracts) {
    const versions = byId.get(contract.id) ?? new Map<string, ModuleContract>();
    if (versions.has(contract.version)) {
      throw new DuplicateModuleError(contract.id, contract.version);
    }
    versions.set(contract.version, contract);
    byId.set(contract.id, versions);
  }

  const sortedVersions = (id: string): string[] => {
    const versions = byId.get(id);
    return versions === undefined ? [] : [...versions.keys()].sort(compareVersions);
  };

  return {
    list() {
      const out: ModuleContract[] = [];
      for (const id of [...byId.keys()].sort()) {
        for (const version of sortedVersions(id)) {
          const contract = byId.get(id)?.get(version);
          if (contract !== undefined) {
            out.push(contract);
          }
        }
      }
      return out;
    },
    ids() {
      return [...byId.keys()].sort();
    },
    has(id) {
      return byId.has(id);
    },
    get(id) {
      const versions = sortedVersions(id);
      const latest = versions[versions.length - 1];
      return latest === undefined ? undefined : byId.get(id)?.get(latest);
    },
    getVersion(id, version) {
      return byId.get(id)?.get(version);
    },
    versions(id) {
      return sortedVersions(id);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return undefined;
    }
    out.push(entry);
  }
  return out;
}

/** Validate `value` as a `GenomeManifest`, throwing `GenomeLoadError` on error. */
export function parseGenomeManifest(value: unknown, source?: string): GenomeManifest {
  if (!isRecord(value)) {
    throw new GenomeLoadError('manifest must be a JSON object.', source);
  }
  const version = value.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new GenomeLoadError('manifest.version must be a non-empty string.', source);
  }
  const pipeline = parseStringArray(value.pipeline);
  if (pipeline === undefined) {
    throw new GenomeLoadError('manifest.pipeline must be an array of module ids.', source);
  }
  const modules = parseStringArray(value.modules);
  if (modules === undefined || modules.length === 0) {
    throw new GenomeLoadError('manifest.modules must be a non-empty array of file paths.', source);
  }
  return { version, pipeline, modules };
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new GenomeLoadError(
      `unable to read file: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new GenomeLoadError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
}

/**
 * Load + validate a genome directory: read the `factory.json` manifest, then
 * each referenced module file (validated via `parseModuleContract`), build the
 * registry, and verify pipeline/dependency references resolve. Throws
 * `GenomeLoadError` / `ModuleContractError` with the offending source path.
 */
export async function loadModuleRegistry(genomeDir: string): Promise<LoadedGenome> {
  const manifestPath = join(genomeDir, GENOME_MANIFEST_FILENAME);
  const manifest = parseGenomeManifest(await readJson(manifestPath), manifestPath);

  const contracts: ModuleContract[] = [];
  for (const relativePath of manifest.modules) {
    const modulePath = join(genomeDir, relativePath);
    const json = await readJson(modulePath);
    contracts.push(parseModuleContract(json, modulePath));
  }

  const registry = createModuleRegistry(contracts);

  for (const id of manifest.pipeline) {
    if (!registry.has(id)) {
      throw new GenomeLoadError(
        `manifest pipeline references unknown module "${id}".`,
        manifestPath,
      );
    }
  }
  for (const contract of contracts) {
    for (const dependency of contract.dependsOn ?? []) {
      if (!registry.has(dependency)) {
        throw new GenomeLoadError(
          `module "${contract.id}" depends on unknown module "${dependency}".`,
          genomeDir,
        );
      }
    }
  }

  return { genomeDir, manifest, registry };
}
