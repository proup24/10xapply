import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  disqualifiedReason,
  openRecord,
  parseRecord,
  RecordError,
  startDecision,
  type JobEntry,
} from './record.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'record-'));
});

const RUN = '2026-11-14T09:58:00.000Z';

describe('openRecord', () => {
  it('a missing file is an empty record', () => {
    expect(openRecord(join(dir, 'a.json')).get('1')).toBeNull();
  });

  it('a read error other than a missing file is a RecordError, never empty', () => {
    const p = join(dir, 'a.json');
    mkdirSync(p); // reading a directory fails with EISDIR
    expect(() => openRecord(p)).toThrow(RecordError);
    expect(() => openRecord(p)).toThrow('applications record is unreadable');
  });

  it('a file that is not JSON is a RecordError', () => {
    const p = join(dir, 'a.json');
    writeFileSync(p, '{');
    expect(() => openRecord(p)).toThrow(RecordError);
  });

  it('a file that fails the schema is a RecordError', () => {
    const p = join(dir, 'a.json');
    writeFileSync(p, '{"version":2,"jobs":{}}');
    expect(() => openRecord(p)).toThrow(RecordError);
    writeFileSync(
      p,
      '{"version":1,"jobs":{"abc":{"status":"applied","updatedAt":"x","history":[]}}}',
    );
    expect(() => openRecord(p)).toThrow(RecordError);
  });

  it('a job id key must be digits', () => {
    const entry = { status: 'applied', updatedAt: 'x', history: [] };
    expect(() =>
      parseRecord(JSON.stringify({ version: 1, jobs: { '12a': entry } })),
    ).toThrow(RecordError);
    expect(
      parseRecord(JSON.stringify({ version: 1, jobs: { '123': entry } })).jobs[
        '123'
      ]?.status,
    ).toBe('applied');
  });

  it('set writes status, updatedAt and appends history with runStartedAt', () => {
    const p = join(dir, 'a.json');
    const s = openRecord(p, () => new Date('2026-11-14T10:00:00.000Z'));
    s.set('42', { status: 'submitting' }, RUN);
    const e = s.set('42', { status: 'applied', source: 'submit' }, RUN);
    expect(e).toMatchObject({
      status: 'applied',
      source: 'submit',
      updatedAt: '2026-11-14T10:00:00.000Z',
    });
    expect(e.history.map((h) => h.status)).toEqual(['submitting', 'applied']);
    expect(e.history[0]).toMatchObject({ runStartedAt: RUN });
    expect(parseRecord(readFileSync(p, 'utf8')).jobs['42']?.status).toBe(
      'applied',
    );
  });

  it('a later status drops a stale source or reason', () => {
    const s = openRecord(join(dir, 'a.json'));
    s.set('7', { status: 'failed', reason: 'submit-unconfirmed' }, RUN);
    const e = s.set('7', { status: 'applied', source: 'linkedin-marker' }, RUN);
    expect(e).not.toHaveProperty('reason');
    expect(e.source).toBe('linkedin-marker');
    const f = s.set('7', { status: 'failed', reason: 'x' }, RUN);
    expect(f).not.toHaveProperty('source');
  });

  it('set re-reads the file, so another writer’s change is kept', () => {
    const p = join(dir, 'a.json');
    const a = openRecord(p);
    const b = openRecord(p);
    a.set('1', { status: 'submitting' }, RUN);
    b.set('2', { status: 'submitting' }, RUN);
    expect(a.get('2')).not.toBeNull();
    expect(b.get('1')).not.toBeNull();
  });

  it('set leaves no temp file behind', () => {
    openRecord(join(dir, 'a.json')).set('1', { status: 'submitting' }, RUN);
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
});

describe('startDecision', () => {
  it.each([
    [null, false, 'go'],
    [null, true, 'go'],
    ['failed', false, 'go'],
    ['failed', true, 'go'],
    ['applied', false, 'refuse-applied'],
    ['applied', true, 'refuse-applied'],
    ['disqualified', false, 'refuse-disqualified'],
    ['disqualified', true, 'refuse-disqualified'],
    ['submitting', false, 'settle-leftover'],
    ['submitting', true, 'go'],
  ] as const)('startDecision(%s, dryRun %s) is %s', (status, dryRun, want) => {
    const entry = status
      ? ({ status, updatedAt: 'x', history: [] } as JobEntry)
      : null;
    expect(startDecision(entry, dryRun)).toBe(want);
  });
});

it('disqualifiedReason', () => {
  expect(
    disqualifiedReason({ kind: 'requires-location', countries: ['DE'] }),
  ).toBe('requires-location:DE');
  expect(
    disqualifiedReason({
      kind: 'requires-authorization',
      countries: ['US', 'CA'],
    }),
  ).toBe('requires-authorization:US,CA');
  expect(disqualifiedReason({ kind: 'no-sponsorship', countries: [] })).toBe(
    'no-sponsorship:unclear',
  );
});
