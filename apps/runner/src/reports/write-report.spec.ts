import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  pathPrefix,
  writeRunReport,
  type SessionReport,
} from './write-report.js';

describe('pathPrefix', () => {
  it.each([
    ['/in/some-handle/', '/in/'],
    ['/feed/foryou/', '/feed/'],
    ['/', '/'],
  ])('%s -> %s', (p, want) => {
    expect(pathPrefix(p)).toBe(want);
  });
});

describe('writeRunReport', () => {
  it('writes valid JSON with exactly the report keys, no colon in the name', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'rr-')), 'nested');
    const report: SessionReport = {
      kind: 'session',
      startedAt: '2026-11-11T10:20:30.000Z',
      result: 'signed-in',
      pathPrefix: '/feed/',
      timings: { loadMs: 1, totalMs: 2 },
    };
    const file = writeRunReport(report, dir);
    expect(basename(file)).not.toContain(':');
    expect(basename(file)).toBe('session-2026-11-11T10-20-30.000Z.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(parsed).sort()).toEqual(
      ['kind', 'startedAt', 'result', 'pathPrefix', 'timings'].sort(),
    );
    expect(parsed).toEqual(report);
  });
});
