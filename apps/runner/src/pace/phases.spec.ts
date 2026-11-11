import { describe, expect, it } from 'vitest';
import { phaseContext, phaseOf, phasesOf } from './phases.js';
import type {
  Ctx,
  PageInfo,
  RecordedEvent,
  Recording,
  Target,
} from './recording.js';

const JOB = '/jobs/view/:id/';

function ev(
  t: number,
  type: RecordedEvent['type'],
  ctx: Partial<Ctx> = {},
  target: Target = { kind: 'other' },
): RecordedEvent {
  return {
    t,
    type,
    trusted: true,
    target,
    ctx: { path: JOB, dialog: false, progress: null, ...ctx },
  };
}

function page(t: number, height: number | null): PageInfo {
  return {
    t,
    ctx: { path: JOB, dialog: false, progress: null },
    desc: height === null ? null : { chars: 2000, height },
    win: {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 800,
      innerWidth: 1200,
      innerHeight: 700,
    },
    screen: { width: 1920, height: 1080 },
    dpr: 1,
  };
}

function rec(events: RecordedEvent[], pages: PageInfo[] = []): Recording {
  return {
    version: 1,
    actor: 'author',
    source: 'linkedin',
    sittingId: 'S',
    jobKey: 'k',
    pages,
    events,
  };
}

const dlg = (progress: number): Partial<Ctx> => ({ dialog: true, progress });
const button: Target = { kind: 'button' };

describe('phaseOf', () => {
  it('/jobs/ with no dialog is job-page', () => {
    expect(phaseOf(ev(10, 'pointermove'), [page(0, 100)])).toEqual({
      phase: 'job-page',
      step: null,
    });
  });

  it('an event on a target inDescription is description', () => {
    const e = ev(10, 'wheel', {}, { kind: 'other', inDescription: true });
    expect(phaseOf(e, [page(0, 100)]).phase).toBe('description');
  });

  it('an event after desc.height grew by more than 20% is description', () => {
    const pages = [page(0, 100), page(50, 121)];
    expect(phaseOf(ev(40, 'pointermove'), pages).phase).toBe('job-page');
    expect(phaseOf(ev(60, 'pointermove'), pages).phase).toBe('description');
  });

  it('growth of 20% or less is not description', () => {
    const pages = [page(0, 100), page(50, 120)];
    expect(phaseOf(ev(60, 'pointermove'), pages).phase).toBe('job-page');
  });

  it('a dialog with progress 33 is easy-apply-step 1, 66 is step 2', () => {
    const events = [ev(1, 'click', dlg(33)), ev(2, 'click', dlg(66))];
    const ctx = phaseContext(events);
    expect(phaseOf(events[0], [], ctx)).toEqual({
      phase: 'easy-apply-step',
      step: 1,
    });
    expect(phaseOf(events[1], [], ctx)).toEqual({
      phase: 'easy-apply-step',
      step: 2,
    });
  });

  it('steps rank among the progress values seen (33/66/83 → 1/2/3)', () => {
    const events = [33, 66, 83, 100].map((p, i) => ev(i, 'click', dlg(p)));
    expect(phasesOf(rec(events)).map((p) => p.step)).toEqual([1, 2, 3, null]);
  });

  it('a dialog with progress 100 is review', () => {
    expect(phaseOf(ev(1, 'pointermove', dlg(100)), [])).toEqual({
      phase: 'review',
      step: null,
    });
  });
});

describe('phasesOf', () => {
  it('a click on a button during review followed by the dialog closing is submitted', () => {
    const events = [
      ev(1, 'pointerdown', dlg(66), button),
      ev(2, 'click', dlg(66), button),
      ev(3, 'pointerdown', dlg(100), button),
      ev(4, 'click', dlg(100), button),
      ev(5, 'pointermove'),
    ];
    expect(phasesOf(rec(events)).map((p) => p.phase)).toEqual([
      'easy-apply-step',
      'easy-apply-step',
      'submitted',
      'submitted',
      'submitted',
    ]);
  });

  it('a review click followed by more dialog presses is not submitted', () => {
    const events = [
      ev(1, 'pointerdown', dlg(100), button),
      ev(2, 'click', dlg(100), button),
      ev(3, 'pointerdown', dlg(66), button),
      ev(4, 'click', dlg(66), button),
    ];
    expect(phasesOf(rec(events)).map((p) => p.phase)).toEqual([
      'review',
      'review',
      'easy-apply-step',
      'easy-apply-step',
    ]);
  });

  it('a review click where the dialog stays open but nothing more is pressed is submitted (practice page)', () => {
    const events = [
      ev(1, 'pointerdown', dlg(100), button),
      ev(2, 'click', dlg(100), button),
      ev(3, 'pointermove', dlg(100)),
    ];
    expect(phasesOf(rec(events)).map((p) => p.phase)).toEqual([
      'submitted',
      'submitted',
      'submitted',
    ]);
  });

  it('a recording with no dialog has no steps', () => {
    const events = [ev(1, 'pointermove'), ev(2, 'click', {}, button)];
    expect(phasesOf(rec(events, [page(0, 100)]))).toEqual([
      { phase: 'job-page', step: null },
      { phase: 'job-page', step: null },
    ]);
  });
});
