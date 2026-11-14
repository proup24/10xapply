import type { Claim } from '@xapply/disqualify';
import { disqualifiedReason, type StatusChange } from './record.js';
import type { ApplyDeps, ApplyRun } from './types.js';

type Recording = { deps: ApplyDeps; run: ApplyRun };

/**
 * The one way a run writes its record. A write that throws leaves
 * `run.record.after` as it was and returns false; the caller decides what
 * that means. A null record writes nothing and returns false.
 */
export function recordSet(w: Recording, change: StatusChange): boolean {
  const store = w.deps.record;
  if (store === null) return false;
  try {
    const entry = store.set(w.run.jobId, change, w.run.startedAt);
    w.run.record.after = entry.status;
    return true;
  } catch {
    return false;
  }
}

/** A disqualification, recorded with its headline reason (no text). */
export function recordDisqualified(w: Recording, reasons: Claim[]): void {
  w.run.via = 'linkedin';
  const first = reasons[0];
  if (first) {
    recordSet(w, {
      status: 'disqualified',
      reason: disqualifiedReason(first),
    });
  }
}
