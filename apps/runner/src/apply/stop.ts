import type { Pace } from '../pace/pace.js';
import type { ApplyDeps, ApplyOutcome, ApplyRun, SafetyStop } from './types.js';

type StopInfo = Omit<NonNullable<ApplyRun['stop']>, 'step' | 'pathPrefix'>;

/** Ends the run: thrown anywhere in the walk, caught once in runApply. */
export class RunEnd extends Error {
  constructor(
    readonly outcome: ApplyOutcome,
    readonly stop?: StopInfo,
  ) {
    super(outcome);
    this.name = 'RunEnd';
  }
}

export function safety(
  kind: SafetyStop,
  detail: string,
  pageErrors?: string[],
): RunEnd {
  return new RunEnd(
    'safety-stop',
    pageErrors ? { kind, detail, pageErrors } : { kind, detail },
  );
}

/** Ctrl+C or the bridge going away: the run ends as `stopped`. */
export function checkStop(deps: Pick<ApplyDeps, 'stopReason'>): void {
  const reason = deps.stopReason();
  if (reason !== null) {
    throw new RunEnd('stopped', { kind: 'bridge', detail: reason });
  }
}

/** Any other error mid-run: a bridge stop, with only its first line kept. */
export function asRunEnd(e: unknown, deps: ApplyDeps): RunEnd {
  if (e instanceof RunEnd) return e;
  const reason = deps.stopReason();
  if (reason !== null) {
    return new RunEnd('stopped', { kind: 'bridge', detail: reason });
  }
  const message = e instanceof Error ? e.message : String(e);
  const first = (message.split('\n')[0] ?? '').slice(0, 200);
  return new RunEnd('stopped', { kind: 'bridge', detail: first });
}

/** `pace` with `stopReason()` checked before every action it takes. */
export function guardPace(pace: Pace, deps: ApplyDeps): Pace {
  const g =
    <A extends unknown[]>(f: (...a: A) => Promise<void>) =>
    async (...a: A) => {
      checkStop(deps);
      await f(...a);
    };
  return {
    mood: pace.mood,
    defaulted: pace.defaulted,
    click: g((t) => pace.click(t)),
    type: g((f, text) => pace.type(f, text)),
    clear: g((f) => pace.clear(f)),
    glance: g((f) => pace.glance(f)),
    pick: g((c, i) => pace.pick(c, i)),
    upload: g((b, p) => pace.upload(b, p)),
    scroll: g((a, n) => pace.scroll(a, n)),
    read: g((n) => pace.read(n)),
    pause: g(() => pace.pause()),
    maybe: (a) => pace.maybe(a),
  };
}
