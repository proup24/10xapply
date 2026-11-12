import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FactBankError, type FactBank } from '@xapply/fact-bank';
import type { Bridge } from '../bridge/bridge.js';
import { INTERRUPTED } from '../apply/run.js';
import type { ApplyDeps, ApplyRun } from '../apply/types.js';
import { applyCommand, type ApplyCommandDeps } from './apply.js';

const URL_OK = 'https://www.linkedin.com/jobs/view/4242/';
const MARKERS = [
  'MARKER-TITLE',
  'MARKER-COMPANY',
  'MARKER-LABEL',
  'MARKER-VALUE',
  'MARKER-DETAIL',
  'MARKER-ERROR',
  'MARKER-PAGE-ERROR',
];

function makeBank(): FactBank {
  const dir = mkdtempSync(join(tmpdir(), 'apply-cmd-'));
  const resume = join(dir, 'resume.pdf');
  writeFileSync(resume, '%PDF-1.4\n');
  return { answers: [], fields: { resume } } as unknown as FactBank;
}

function markedRun(): ApplyRun {
  return {
    jobId: '4242',
    startedAt: '2026-11-12T10:00:00.000Z',
    outcome: 'stopped',
    stop: {
      kind: 'error',
      step: 2,
      detail: 'MARKER-DETAIL',
      error: 'MARKER-ERROR',
      pageErrors: ['MARKER-PAGE-ERROR'],
      pathPrefix: '/jobs/view',
    },
    job: {
      title: 'MARKER-TITLE',
      company: 'MARKER-COMPANY',
      description: '',
      source: 'linkedin',
    },
    questions: [
      {
        step: 1,
        question: {
          id: 's1-q1',
          label: 'MARKER-LABEL',
          type: 'text',
          required: true,
        } as ApplyRun['questions'][number]['question'],
        result: null,
        by: 'author',
        filled: 'MARKER-VALUE',
        changedFromLinkedIn: false,
      },
    ],
    unknownFields: [],
    timings: { totalMs: 10, perStepMs: [5, 5] },
  };
}

function fakeBridge(): Bridge & { closed: number } {
  const b = {
    closed: 0,
    openRunWindow: vi.fn(),
    stopReason: () => null,
    crashRunTab: vi.fn(),
    viewport: async () => null,
    pageHtml: async () => '',
    uploadOnChooser: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    onRecorderBatch: vi.fn(),
    close: async () => {
      b.closed++;
    },
  };
  return b as unknown as Bridge & { closed: number };
}

interface Harness {
  deps: Partial<ApplyCommandDeps>;
  lines: string[];
  connect: ReturnType<typeof vi.fn>;
  loadBank: ReturnType<typeof vi.fn>;
  written: ApplyRun[];
  bridge: Bridge & { closed: number };
}

function harness(over: Partial<ApplyCommandDeps> = {}): Harness {
  const lines: string[] = [];
  const bridge = fakeBridge();
  const bank = makeBank();
  const written: ApplyRun[] = [];
  const connect = vi.fn(async () => bridge);
  const loadBank = vi.fn(() => bank);
  const deps: Partial<ApplyCommandDeps> = {
    authorMode: false,
    out: (l) => void lines.push(l),
    bankPath: '/nowhere/bank.yaml',
    loadBank,
    installResume: () => ({
      fileName: 'resume.pdf',
      windowsPath: 'C:\\x\\resume.pdf',
    }),
    loadConfig: () => ({ token: 't', relayPort: 9333 }),
    loadAnswerConfig: () => ({
      answerModel: 'a',
      verifyModel: 'v',
      judgeModel: 'j',
      maxRegenerations: 1,
    }),
    loadProfile: () => ({}) as never,
    connect,
    runApply: async () => markedRun(),
    writeReports: (run) => {
      written.push(run);
      return {
        full: '/full/MARKER-FULL-PATH.md',
        redacted: '/reports/apply-redacted.json',
      };
    },
    onSigint: () => () => undefined,
    ...over,
  };
  return { deps, lines, connect, loadBank, written, bridge };
}

describe('applyCommand', () => {
  it('refuses without --dry-run before connecting', async () => {
    const h = harness();
    expect(await applyCommand([URL_OK], h.deps)).toBe(2);
    expect(h.lines).toEqual([
      'apply: submitting comes in slice 07; use --dry-run',
    ]);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.loadBank).not.toHaveBeenCalled();
  });

  it('bad url exits 2', async () => {
    const h = harness();
    expect(
      await applyCommand(
        ['https://example.com/jobs/view/1', '--dry-run'],
        h.deps,
      ),
    ).toBe(2);
    expect(await applyCommand(['--dry-run'], h.deps)).toBe(2);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('non-author mode prints only the redacted summary', async () => {
    const h = harness();
    expect(await applyCommand([URL_OK, '--dry-run'], h.deps)).toBe(2);
    const out = h.lines.join('\n');
    expect(out).toContain('apply: stopped');
    expect(out).toContain('stop: error at step 2');
    expect(out).toContain('/reports/apply-redacted.json');
    expect(out).not.toContain('MARKER');
    for (const m of MARKERS) expect(out).not.toContain(m);
    expect(h.bridge.closed).toBe(1);
  });

  it('author mode prints the run markdown and both paths', async () => {
    const h = harness({ authorMode: true });
    await applyCommand([URL_OK, '--dry-run'], h.deps);
    const out = h.lines.join('\n');
    expect(out).toContain('# Apply run 4242');
    expect(out).toContain('MARKER-ERROR');
    expect(out).toContain('/reports/apply-redacted.json');
    expect(out).toContain('/full/MARKER-FULL-PATH.md');
  });

  it('exits 0 on reached-review', async () => {
    const h = harness({
      runApply: async () => ({
        ...markedRun(),
        outcome: 'reached-review',
        stop: undefined,
      }),
    });
    expect(await applyCommand([URL_OK, '--dry-run'], h.deps)).toBe(0);
  });

  it('a bank that fails to load prints problems and never connects', async () => {
    const h = harness({
      loadBank: () => {
        throw new FactBankError([
          { where: 'fields.email', message: 'is required' },
        ]);
      },
    });
    expect(await applyCommand([URL_OK, '--dry-run'], h.deps)).toBe(2);
    expect(h.lines.join('\n')).toContain('fields.email');
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('a missing resume exits 2 before connecting', async () => {
    const h = harness({
      loadBank: () =>
        ({
          answers: [],
          fields: { resume: '/nowhere/resume.pdf' },
        }) as unknown as FactBank,
    });
    expect(await applyCommand([URL_OK, '--dry-run'], h.deps)).toBe(2);
    expect(h.lines.join('\n')).toContain('resume');
    expect(h.lines.join('\n')).not.toContain('/nowhere');
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('bridge unavailable still writes a report and exits 2', async () => {
    const run = vi.fn();
    const h = harness({
      connect: async () => ({ unavailable: 'no bridge' }),
      runApply: run,
    });
    expect(await applyCommand([URL_OK, '--dry-run'], h.deps)).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.outcome).toBe('bridge-unavailable');
    expect(h.written[0]?.jobId).toBe('4242');
    expect(h.lines.join('\n')).toContain('apply: bridge-unavailable');
  });

  it('Ctrl+C makes stopReason interrupted and the listener is removed', async () => {
    let handler: (() => void) | null = null;
    let removed = false;
    let seen: string | null = 'unset';
    const h = harness({
      onSigint: (fn) => {
        handler = fn;
        return () => {
          removed = true;
        };
      },
      runApply: async (_id: string, deps: ApplyDeps) => {
        expect(deps.stopReason()).toBeNull();
        handler?.();
        seen = deps.stopReason();
        return markedRun();
      },
    });
    await applyCommand([URL_OK, '--dry-run'], h.deps);
    expect(seen).toBe(INTERRUPTED);
    expect(removed).toBe(true);
  });

  it('passes the job id, a null io outside author mode and the resume', async () => {
    let got: { id: string; deps: ApplyDeps } | null = null;
    const h = harness({
      runApply: async (id: string, deps: ApplyDeps) => {
        got = { id, deps };
        return markedRun();
      },
    });
    await applyCommand(
      ['https://www.linkedin.com/jobs/search/?currentJobId=4242', '--dry-run'],
      h.deps,
    );
    const g = got as unknown as { id: string; deps: ApplyDeps };
    expect(g.id).toBe('4242');
    expect(g.deps.io).toBeNull();
    expect(g.deps.resume.fileName).toBe('resume.pdf');
  });
});
