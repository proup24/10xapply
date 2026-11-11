import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx, RecorderBatch, RecordedEvent } from './recording.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const fs = await import('node:fs');
const { createWriter, sourceFromCtx } = await import('./writer.js');

const ctx = (path: string): Ctx => ({ path, dialog: false, progress: null });
const ev = (
  type: RecordedEvent['type'],
  path = '/jobs/:id',
): RecordedEvent => ({
  t: 1,
  type,
  trusted: true,
  target: { kind: 'other' },
  ctx: ctx(path),
});
const batch = (
  jobKey: string | null,
  types: RecordedEvent['type'][],
  path = '/jobs/:id',
  pageId = 'p1',
): RecorderBatch => ({ pageId, jobKey, events: types.map((t) => ev(t, path)) });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pace-writer-'));
});
afterEach(() => {
  vi.mocked(fs.renameSync).mockClear();
  rmSync(dir, { recursive: true, force: true });
});

const make = () => createWriter({ dir, actor: 'author', sittingId: 'S1' });

describe('writer', () => {
  it('groups by jobKey', () => {
    const w = make();
    w.add(batch('a', ['click']));
    w.add(batch('b', ['click']));
    w.add(batch('a', ['wheel']));
    w.add(batch(null, ['click']));
    const paths = w.flush().sort();
    expect(paths.map((p) => p.slice(dir.length))).toEqual([
      '/author/linkedin/S1-a.json',
      '/author/linkedin/S1-b.json',
      '/author/linkedin/S1-none.json',
    ]);
    const a = JSON.parse(readFileSync(paths[0] ?? '', 'utf8'));
    expect(a).toMatchObject({
      version: 1,
      actor: 'author',
      source: 'linkedin',
      sittingId: 'S1',
      jobKey: 'a',
    });
    expect(a.events).toHaveLength(2);
  });

  it('source from ctx path', () => {
    expect(sourceFromCtx(ctx('/practice/x'))).toBe('practice');
    expect(sourceFromCtx(ctx('/typing/'))).toBe('typing');
    expect(sourceFromCtx(ctx('/jobs/view/:id'))).toBe('linkedin');
    expect(sourceFromCtx(ctx('/other'))).toBe('test-page');
    const w = make();
    w.add(batch('k', ['click'], '/typing/'));
    expect(w.flush()[0]).toContain('/author/typing/');
  });

  it('writes atomically', () => {
    const w = make();
    w.add(batch('a', ['click']));
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('crash');
    });
    expect(() => w.flush()).toThrow('crash');
    const files = readdirSync(join(dir, 'author', 'linkedin'));
    expect(files).toEqual(['S1-a.json.tmp']);
    expect(existsSync(join(dir, 'author', 'linkedin', 'S1-a.json'))).toBe(
      false,
    );
  });

  it('counts', () => {
    const w = make();
    w.add(
      batch('a', ['click', 'wheel', 'keydown', 'keyup', 'keydown', 'keydown']),
    );
    w.add(batch('a', ['click'], '/jobs/:id', 'p2'));
    expect(w.counts()).toEqual({ pages: 2, clicks: 2, keyGaps: 2, wheels: 1 });
  });
});
