'use client';

/**
 * RunCompletionToast — pops when the watched run TRANSITIONS to completed
 * while the operator is on the page (a poll flips the projected status), so
 * a finish never goes unnoticed. "View report" scrolls to the Build report;
 * the toast never re-fires for a run that was already completed on load
 * (the report itself is the resting-state surface for that).
 */
import { useEffect, useRef, useState } from 'react';
import type { RunStatus } from '@software-factory/core';

export function RunCompletionToast({
  status,
  runId,
}: {
  readonly status: RunStatus;
  readonly runId: string;
}) {
  const [visible, setVisible] = useState(false);
  // ONE tracking ref for both run identity and last status: two separate
  // effects raced (the run-reset effect nulled the status the transition
  // check had just recorded), silently eating legitimate transitions.
  const tracked = useRef<{ runId: string; status: RunStatus } | null>(null);

  useEffect(() => {
    const prev = tracked.current;
    if (prev !== null && prev.runId !== runId) {
      // A different focused run: hide and start tracking fresh (no pop for a
      // run that was already completed when focus arrived).
      setVisible(false);
    } else if (prev !== null && prev.status !== 'completed' && status === 'completed') {
      setVisible(true);
    }
    tracked.current = { runId, status };
  }, [status, runId]);

  if (!visible) {
    return null;
  }

  return (
    <div className="run-toast" role="status" aria-live="polite" data-testid="run-completion-toast">
      <span className="run-toast__title">✓ Run completed</span>
      <span>The build finished — see what was built.</span>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        onClick={() => {
          document.getElementById('run-report')?.scrollIntoView({ behavior: 'smooth' });
          setVisible(false);
        }}
      >
        View build report
      </button>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        aria-label="Dismiss completion notice"
        onClick={() => setVisible(false)}
      >
        ✕
      </button>
    </div>
  );
}
