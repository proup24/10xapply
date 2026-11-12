import { describe, expect, it } from 'vitest';
import {
  evaluate,
  expressionNumbers,
  MathError,
  MONTHS,
  numbersIn,
  optionContains,
  yearsSince,
} from './math.js';

describe('numbersIn', () => {
  it('reads plain numbers', () => {
    expect(numbersIn('5000 USD per month, 30 USD per hour')).toEqual([
      5000, 30,
    ]);
  });
  it('reads commas, decimals and percentages', () => {
    expect(numbersIn('5,000 and 2.5 and 30%')).toEqual([5000, 2.5, 30]);
  });
  it('reads number words but not one or a', () => {
    expect(numbersIn('led two teams for one year')).toEqual([2]);
    expect(numbersIn('a team of Twenty and a hundred')).toEqual([20, 100]);
  });
  it('matches whole words only', () => {
    expect(numbersIn('someone tenfold')).toEqual([]);
  });
  it('never reads a minus sign', () => {
    expect(numbersIn('2026-11-12')).toEqual([2026, 11, 12]);
  });
});

describe('evaluate', () => {
  it('computes', () => {
    expect(evaluate('2026 - 2021')).toBe(5);
    expect(evaluate('(10 + 2) × 3 ÷ 4')).toBe(9);
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('2026 − 2021')).toBe(5);
    expect(evaluate('1.5 * 2')).toBe(3);
  });
  it('rejects anything else', () => {
    for (const bad of [
      'process.exit()',
      '2 ** 3',
      '',
      '1 +',
      '(1',
      '1 / 0',
      '-1',
      '1 2',
    ]) {
      expect(() => evaluate(bad)).toThrow(MathError);
    }
  });
  it('never quotes the input in the error', () => {
    try {
      evaluate('secret-value()');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret');
    }
  });
});

describe('expressionNumbers', () => {
  it('lists the numbers in the expression', () => {
    expect(expressionNumbers('(10 + 2.5) × 3')).toEqual([10, 2.5, 3]);
    expect(() => expressionNumbers('a + 1')).toThrow(MathError);
  });
});

describe('yearsSince', () => {
  it('counts whole years', () => {
    expect(yearsSince({ year: 2021 }, '2026-11-12')).toBe(5);
    expect(yearsSince({ year: 2021, month: 12 }, '2026-11-12')).toBe(4);
    expect(yearsSince({ year: 2021, month: 11 }, '2026-11-12')).toBe(5);
    expect(() => yearsSince({ year: 2027 }, '2026-11-12')).toThrow(MathError);
    expect(() => yearsSince({ year: 2021, month: 13 }, '2026-11-12')).toThrow(
      MathError,
    );
    expect(() => yearsSince({ year: 2021 }, 'tomorrow')).toThrow(MathError);
  });
});

describe('MONTHS', () => {
  it('maps names and short forms', () => {
    expect(MONTHS['january']).toBe(1);
    expect(MONTHS['jan']).toBe(1);
    expect(MONTHS['december']).toBe(12);
  });
});

describe('optionContains', () => {
  it('reads ranges, open ends and bare numbers, case-insensitively', () => {
    const cases: Array<[string, number, boolean]> = [
      ['0-2', 2, true],
      ['0-2', 3, false],
      ['3 – 5 years', 5, true],
      ['3 — 5 years', 6, false],
      ['3 to 5 Years', 3, true],
      ['6+', 6, true],
      ['6+ years', 5, false],
      ['10 or more years', 10, true],
      ['More than 5 years', 5, false],
      ['more than 5 years', 6, true],
      ['Over 5 yrs', 6, true],
      ['Less than 1 year', 0, true],
      ['less than 1 year', 1, false],
      ['Under 2 years', 2, false],
      ['Up to 2 years', 2, true],
      ['up to 2 years', 3, false],
      ['5', 5, true],
      ['5 years', 4, false],
      ['1 year of experience', 1, true],
    ];
    for (const [option, n, want] of cases) {
      expect(optionContains(option, n), `${option} / ${n}`).toBe(want);
    }
  });
  it('returns null for an option it cannot read', () => {
    for (const option of [
      'Immediate',
      'Senior',
      '3-5 years in management',
      'Between jobs',
      '',
    ]) {
      expect(optionContains(option, 5), option).toBeNull();
    }
  });
});
