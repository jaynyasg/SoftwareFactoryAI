/**
 * Per-run credential redactor (multi-user U7).
 *
 * Worker CLIs run with the OWNER's decrypted credentials in their environment
 * (U6 spawn bundles), and their streamed output feeds ledger appends —
 * progress messages, wait notes, retry/failure reasons, completion summaries.
 * A CLI that echoes its environment (or an error that quotes a header) would
 * otherwise persist a live credential on the append-only ledger forever.
 *
 * `createRollingRedactor` scrubs every known secret VALUE from a sequence of
 * texts. It is stateful across calls with a rolling carry buffer at least as
 * long as the longest secret, so a credential split across two stream writes
 * ("sk-abc" at the end of one chunk, "def123" at the start of the next) is
 * still caught: the earlier text is already appended, so the LATER text has
 * its spanning prefix redacted — the full value is never reconstructible from
 * the appended sequence.
 */

/** What a redacted secret is replaced with on the ledger. */
export const REDACTED = '[redacted]';

/**
 * Build a stateful text scrubber over the given secret values. Empty or
 * whitespace-only secrets are ignored (they would redact everything). The
 * same instance must be used for one logical text stream (one run) — state
 * carries across calls; independent runs get independent redactors.
 */
export function createRollingRedactor(
  secrets: readonly string[],
): (text: string) => string {
  const values = [...new Set(secrets.filter((secret) => secret.trim().length >= 4))];
  if (values.length === 0) {
    return (text) => text;
  }
  const maxLen = Math.max(...values.map((value) => value.length));
  // Rolling carry: the UNREDACTED tail of everything seen so far, long enough
  // that any secret spanning a boundary is visible in carry+text.
  let carry = '';

  return (text) => {
    const joined = carry + text;

    // 1) Boundary-spanning occurrences: a secret that starts inside the carry
    //    and ends inside `text`. The carry part is already appended, so cut
    //    the spanning suffix out of THIS text (the full value then never
    //    exists in the appended sequence).
    let cut = 0;
    for (const secret of values) {
      let index = joined.indexOf(secret);
      while (index !== -1) {
        if (index < carry.length && index + secret.length > carry.length) {
          cut = Math.max(cut, index + secret.length - carry.length);
        }
        index = joined.indexOf(secret, index + 1);
      }
    }
    let result = cut > 0 ? REDACTED + text.slice(cut) : text;

    // 2) Whole occurrences inside this text.
    for (const secret of values) {
      result = result.split(secret).join(REDACTED);
    }

    carry = joined.slice(-(maxLen - 1));
    return result;
  };
}
