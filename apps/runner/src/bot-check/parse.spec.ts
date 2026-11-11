import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatTable,
  parseBrowserscan,
  parseDabi,
  parseDabiInteractions,
  parseIncolumitas,
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

describe('parseDabiInteractions', () => {
  it('dabi-interactions passes when all behaviour flags are false', () => {
    const r = parseDabiInteractions(fx('dabi-interactions-clean.txt'));
    expect(r).toEqual({ page: 'dabi-interactions', passed: true, detail: [] });
  });
  it('dabi-interactions fails and names hasCDPMouseLeak', () => {
    const r = parseDabiInteractions(fx('dabi-interactions-leak.txt'));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('hasCDPMouseLeak');
  });
  it('dabi-interactions fails on the real suspicious-behaviour verdict and names it', () => {
    // The verdict the live page gave when pace typed '@' without Shift.
    const text = fx('dabi-interactions-clean.txt')
      .replace('You are human!', 'You are a bot!')
      .replace('"isBot": false', '"isBot": true')
      .replace(
        '"suspiciousClientSideBehavior": false',
        '"suspiciousClientSideBehavior": true',
      );
    const r = parseDabiInteractions(text);
    expect(r.passed).toBe(false);
    expect(r.detail).toEqual(['isBot', 'suspiciousClientSideBehavior']);
  });
  it('dabi-interactions is unparseable before the form is submitted', () => {
    // Real capture: the page explains its flags but shows no result yet.
    const r = parseDabiInteractions(fx('dabi-interactions-unsubmitted.txt'));
    expect(r).toEqual({
      page: 'dabi-interactions',
      passed: false,
      detail: ['unparseable'],
    });
  });
  it('dabi-interactions is unparseable without the flags', () => {
    for (const s of ['', 'nope', '{"isBot": false}']) {
      const r = parseDabiInteractions(s);
      expect(r.passed).toBe(false);
      expect(r.detail).toEqual(['unparseable']);
    }
  });
});

describe('parseIncolumitas', () => {
  it('incolumitas passes on human', () => {
    const r = parseIncolumitas(fx('incolumitas-human.txt'));
    expect(r).toEqual({
      page: 'incolumitas',
      passed: true,
      detail: ['score 0.83'],
    });
  });
  it('incolumitas fails on bot', () => {
    const r = parseIncolumitas(fx('incolumitas-bot.txt'));
    expect(r.passed).toBe(false);
    expect(r.detail).toEqual(['score 0.21']);
  });
  it('incolumitas with no score yet ("...") is not run, never a pass', () => {
    // Real capture: the score's script host was down, so it stayed "...".
    const r = parseIncolumitas(fx('incolumitas-pending.txt'));
    expect(r).toEqual({
      page: 'incolumitas',
      passed: false,
      notRun: true,
      detail: ['no behavioural score (the page still shows "...")'],
    });
  });
  it('incolumitas unparseable', () => {
    for (const s of ['', 'nope', 'Your Behavioral Score: 7']) {
      const r = parseIncolumitas(s);
      expect(r.passed).toBe(false);
      expect(r.detail).toEqual(['unparseable']);
    }
  });
});

describe('formatTable', () => {
  it('shows a not-run result apart from FAIL', () => {
    expect(
      formatTable([{ page: 'x', passed: false, detail: ['n'], notRun: true }]),
    ).toBe('x     NOT RUN  n');
  });
});
