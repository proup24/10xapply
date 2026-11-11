import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatTable,
  parseBrowserscan,
  parseDabi,
  parseRebrowser,
} from './parse.js';

const fx = (n: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8');

describe('parseRebrowser', () => {
  it('passes a clean result', () => {
    expect(parseRebrowser(fx('rebrowser-clean.json')).passed).toBe(true);
  });
  it('fails on a rating 1 leak', () => {
    const r = parseRebrowser(fx('rebrowser-leak.json'));
    expect(r.passed).toBe(false);
    expect(r.detail).toEqual(['runtimeEnableLeak']);
  });
  it('does not throw on malformed input', () => {
    for (const s of ['', 'nope', '{}', '[1]', 'null']) {
      const r = parseRebrowser(s);
      expect(r.passed).toBe(false);
      expect(r.detail).toEqual(['unparseable']);
    }
  });
  it('does not pass an empty array', () => {
    const r = parseRebrowser('[]');
    expect(r.passed).toBe(false);
    expect(r.detail).toEqual(['unparseable']);
  });
  it('is unparseable when an entry has no numeric rating', () => {
    for (const s of [
      '[{"type":"dummyFn"}]',
      '[{"type":"dummyFn","rating":0},{"type":"x","rating":"1"}]',
      '[{"type":"x","rating":null}]',
    ]) {
      const r = parseRebrowser(s);
      expect(r.passed).toBe(false);
      expect(r.detail).toEqual(['unparseable']);
    }
  });
});

describe('parseDabi', () => {
  it('passes a human', () => {
    const r = parseDabi(fx('dabi-human.txt'));
    expect(r.passed).toBe(true);
    expect(r.detail).toEqual([]);
  });
  it('fails a bot and names the true keys', () => {
    const r = parseDabi(fx('dabi-bot.txt'));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('isAutomatedWithCDP');
  });
  it('is unparseable without an isBot key', () => {
    expect(parseDabi('hello')).toMatchObject({
      passed: false,
      detail: ['unparseable'],
    });
  });
});

describe('parseBrowserscan', () => {
  it('passes Normal', () => {
    expect(parseBrowserscan(fx('browserscan-normal.txt')).passed).toBe(true);
  });
  it('fails Robot', () => {
    const r = parseBrowserscan(
      fx('browserscan-normal.txt').replace('Normal', 'Robot'),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toEqual(['Robot']);
  });
  it('is unparseable without the marker', () => {
    expect(parseBrowserscan('x')).toMatchObject({
      passed: false,
      detail: ['unparseable'],
    });
  });
});

describe('formatTable', () => {
  it('prints one row per result', () => {
    const out = formatTable([
      { page: 'a', passed: true, detail: [] },
      { page: 'bb', passed: false, detail: ['x', 'y'] },
    ]);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('PASS');
    expect(out).toContain('FAIL  x, y');
  });
});
