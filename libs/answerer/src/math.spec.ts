import { describe, expect, it } from 'vitest';
import {
  evaluate,
  expressionNumbers,
  MathError,
  MONTHS,
  numbersIn,
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
