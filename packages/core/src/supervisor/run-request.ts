/**
 * Normalize a prompt string, PRD text, or PRD reference into a `RunRequest`.
 *
 * Intake is intentionally permissive (string OR structured input) but the
 * normalized output is strict and deterministic: identical input always yields
 * an identical request, including the detected intent. The supervisor's planner
 * branches on `intent` — recognized product intents get a full plan, while
 * `unknown`/`underspecified` requests are routed to human triage instead of a
 * guessed (and potentially dangerous) build.
 */
import { DEFAULT_REVIEW_MODE } from '../security/review-policy';
import type { ReviewMode } from '../events/event-types';

/**
 * The detected product intent. V1 recognizes only the AI Services Marketplace
 * path; anything else is `unknown` (enough signal to plan, but no known intent)
 * or `underspecified` (not enough signal to plan at all).
 */
export type RunIntent = 'ai-services-marketplace' | 'unknown' | 'underspecified';

/** Structured intake. `prompt`, `prdText`, `prdRef`, or any combination may be present. */
export interface RunRequestInput {
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly prdText?: string;
  readonly title?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
}

/** A normalized, deterministic run request ready for planning. */
export interface RunRequest {
  /** A human-facing title, derived from the prompt/PRD when not supplied. */
  readonly title: string;
  /** The (trimmed) prompt text; empty string when only a PRD ref was given. */
  readonly prompt: string;
  /** A reference to a PRD document, when provided. */
  readonly prdRef?: string;
  /** PRD body text pasted or imported through the UI, when provided. */
  readonly prdText?: string;
  /** Requested upper bound on concurrent workers, clamped to [1, 20]. */
  readonly requestedWorkerCap?: number;
  /** Review mode; defaults to human review. */
  readonly reviewMode: ReviewMode;
  /** The detected product intent. */
  readonly intent: RunIntent;
}

/** Minimum meaningful word count for a prompt to be considered specified. */
const MIN_PROMPT_WORDS = 4;

/** Lower/upper bounds for the requested worker cap. */
const MIN_WORKER_CAP = 1;
const MAX_WORKER_CAP = 20;

/** A strong, unambiguous phrase that pins the marketplace intent on its own. */
const MARKETPLACE_PHRASE = /\bai services? marketplace\b/;

/** Distinct marketplace signals; two or more imply the marketplace intent. */
const MARKETPLACE_SIGNALS: readonly RegExp[] = [
  /\bmarket\s?place\b/,
  /\bproviders?\b/,
  /\bproposals?\b/,
  /\bcustomers?\b/,
  /\bbriefs?\b/,
  /\b(?:service )?requests?\b/,
  /\bai services?\b/,
];

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function deriveTitle(
  prompt: string,
  prdRef: string | undefined,
  prdText: string | undefined,
): string {
  if (prompt.length > 0) {
    const [firstLine = ''] = prompt.split(/\r?\n/, 1);
    const base = firstLine.trim().length > 0 ? firstLine.trim() : prompt;
    return truncate(base, 72);
  }
  if (prdText !== undefined) {
    const [firstLine = ''] = prdText.split(/\r?\n/, 1);
    const base = firstLine.trim().length > 0 ? firstLine.trim() : prdText;
    return truncate(`PRD: ${base}`, 72);
  }
  if (prdRef !== undefined) {
    return truncate(`PRD: ${prdRef}`, 72);
  }
  return 'Untitled run';
}

function normalizeWorkerCap(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.trunc(value);
  if (integer < MIN_WORKER_CAP) {
    return MIN_WORKER_CAP;
  }
  if (integer > MAX_WORKER_CAP) {
    return MAX_WORKER_CAP;
  }
  return integer;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

function detectIntent(
  prompt: string,
  prdRef: string | undefined,
  prdText: string | undefined,
  title: string,
): RunIntent {
  const haystack = `${title} ${prompt} ${prdText ?? ''} ${prdRef ?? ''}`.toLowerCase();

  if (MARKETPLACE_PHRASE.test(haystack)) {
    return 'ai-services-marketplace';
  }
  const distinctSignals = MARKETPLACE_SIGNALS.filter((pattern) => pattern.test(haystack)).length;
  if (distinctSignals >= 2) {
    return 'ai-services-marketplace';
  }

  // A PRD reference is treated as specified content even when we cannot read it
  // here; lack of recognizable signals makes the intent unknown (-> triage).
  if (prdRef !== undefined || prdText !== undefined) {
    return 'unknown';
  }
  if (countWords(prompt) < MIN_PROMPT_WORDS) {
    return 'underspecified';
  }
  return 'unknown';
}

/**
 * Parse a raw prompt string or structured intake into a normalized
 * `RunRequest`. Pure and deterministic — no clocks, randomness, or I/O.
 */
export function parseRunRequest(input: string | RunRequestInput): RunRequest {
  const raw: RunRequestInput = typeof input === 'string' ? { prompt: input } : input;

  const prompt = (raw.prompt ?? '').trim();
  const prdTextTrimmed = raw.prdText?.trim();
  const prdText =
    prdTextTrimmed !== undefined && prdTextTrimmed.length > 0 ? prdTextTrimmed : undefined;
  const prdRefTrimmed = raw.prdRef?.trim();
  const prdRef =
    prdRefTrimmed !== undefined && prdRefTrimmed.length > 0 ? prdRefTrimmed : undefined;
  const titleTrimmed = raw.title?.trim();
  const title =
    titleTrimmed !== undefined && titleTrimmed.length > 0
      ? titleTrimmed
      : deriveTitle(prompt, prdRef, prdText);
  const reviewMode = raw.reviewMode ?? DEFAULT_REVIEW_MODE;
  const requestedWorkerCap = normalizeWorkerCap(raw.requestedWorkerCap);
  const intent = detectIntent(prompt, prdRef, prdText, title);

  return {
    title,
    prompt,
    prdRef,
    prdText,
    requestedWorkerCap,
    reviewMode,
    intent,
  };
}
