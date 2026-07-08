/**
 * Research source policy (full-factory U2).
 *
 * Policy is applied BEFORE fetching or indexing anything:
 *  - allowed source classes: a research pass may only consult source kinds the
 *    policy allows,
 *  - network gating: network-backed classes (`web_search`, `documentation`)
 *    additionally require `allowNetwork` (default CLOSED),
 *  - credential requirements: adapters that need provider credentials are
 *    refused (fail closed) when the credentials are absent — the runner records
 *    a setup requirement / gap instead of fabricating research, and
 *  - redaction rules (hardening E5): every summary/statement/body is passed
 *    through `redactSecrets` before it reaches the ledger or knowledge index so
 *    secret values never become evidence.
 *
 * Everything here is pure — evaluation does no I/O and holds no clocks.
 */
import type { ResearchSourceKind } from '@software-factory/core';
import type { ResearchAdapterSetup } from './research-contract';

/** Source classes whose reads leave the machine (require `allowNetwork`). */
export const NETWORK_SOURCE_KINDS: readonly ResearchSourceKind[] = ['web_search', 'documentation'];

const NETWORK_KINDS = new Set<ResearchSourceKind>(NETWORK_SOURCE_KINDS);

/** Whether a source kind reaches the network when read. */
export function isNetworkSourceKind(kind: ResearchSourceKind): boolean {
  return NETWORK_KINDS.has(kind);
}

/** The policy a research pass enforces before consulting any source. */
export interface ResearchSourcePolicy {
  /** Source classes that may be consulted at all. */
  readonly allowedKinds: readonly ResearchSourceKind[];
  /** Whether network-backed source classes may be used (default false). */
  readonly allowNetwork: boolean;
  /** Redaction rules applied to all text before it becomes ledger evidence. */
  readonly redactionPatterns: readonly RegExp[];
}

/**
 * Default redaction rules. Deliberately aggressive: key/token/secret-style
 * assignments lose their values, and well-known credential prefixes are
 * removed wholesale. Producers should never send secrets, but the policy does
 * not trust them to remember (E5: never emit secret values into evidence).
 */
export const DEFAULT_REDACTION_PATTERNS: readonly RegExp[] = [
  // NAME=value / name: value pairs whose name looks like a secret.
  /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential|auth(?:orization)?)[A-Za-z0-9_.-]*)\s*[:=]\s*[^\s"']+/gi,
  // Bearer tokens in header-style text.
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Well-known credential prefixes (OpenAI/GitHub/Slack/AWS style).
  /\b(?:sk-|ghp_|gho_|github_pat_|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g,
];

/** Marker substituted for redacted spans. */
export const REDACTION_MARKER = '[redacted]';

/** All source kinds, used as the default allow-list (network still gated). */
const ALL_SOURCE_KINDS: readonly ResearchSourceKind[] = [
  'web_search',
  'documentation',
  'repo_scan',
  'local_folder',
  'uploaded_prd',
  'model_synthesis',
  'other',
];

/** Resolve a full policy from partial overrides (defaults fail closed). */
export function resolveSourcePolicy(
  overrides: Partial<ResearchSourcePolicy> = {},
): ResearchSourcePolicy {
  return {
    allowedKinds: overrides.allowedKinds ?? ALL_SOURCE_KINDS,
    allowNetwork: overrides.allowNetwork ?? false,
    redactionPatterns: overrides.redactionPatterns ?? DEFAULT_REDACTION_PATTERNS,
  };
}

/** Why a source class / adapter was refused. */
export type SourcePolicyRule =
  | 'kind_not_allowed'
  | 'network_not_allowed'
  | 'not_configured'
  | 'credentials_missing';

/** The outcome of evaluating one adapter against the policy. */
export type SourcePolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly rule: SourcePolicyRule; readonly reason: string };

/**
 * Evaluate whether a source class may be consulted at all (kind + network
 * gates). This runs BEFORE `detectSetup`, so a disallowed class costs no I/O.
 */
export function evaluateSourceClass(
  policy: ResearchSourcePolicy,
  kind: ResearchSourceKind,
): SourcePolicyDecision {
  if (!policy.allowedKinds.includes(kind)) {
    return {
      allowed: false,
      rule: 'kind_not_allowed',
      reason: `Source class '${kind}' is not allowed by the research source policy.`,
    };
  }
  if (isNetworkSourceKind(kind) && !policy.allowNetwork) {
    return {
      allowed: false,
      rule: 'network_not_allowed',
      reason: `Source class '${kind}' requires network access, which the research source policy does not allow.`,
    };
  }
  return { allowed: true };
}

/**
 * Evaluate an adapter's reported setup (fail closed): an unconfigured adapter
 * or one missing required credentials is refused before any fetch.
 */
export function evaluateSourceSetup(setup: ResearchAdapterSetup): SourcePolicyDecision {
  if (!setup.configured) {
    return {
      allowed: false,
      rule: 'not_configured',
      reason: setup.detail ?? 'The research source adapter is not configured.',
    };
  }
  if (setup.requiresCredentials && !setup.credentialsPresent) {
    return {
      allowed: false,
      rule: 'credentials_missing',
      reason:
        setup.detail ??
        'Provider credentials are required but not configured for this research source.',
    };
  }
  return { allowed: true };
}

/**
 * Redact secret-shaped values from text before it becomes ledger evidence or
 * knowledge-index content. Pure and deterministic; patterns are applied in
 * order and every match is replaced with `REDACTION_MARKER`.
 */
export function redactSecrets(
  text: string,
  patterns: readonly RegExp[] = DEFAULT_REDACTION_PATTERNS,
): string {
  let redacted = text;
  for (const pattern of patterns) {
    // Re-create the regex so shared pattern instances keep no lastIndex state.
    const fresh = new RegExp(pattern.source, pattern.flags);
    redacted = redacted.replace(fresh, REDACTION_MARKER);
  }
  return redacted;
}
