import { describe, expect, it } from 'vitest';
import { toTypeable } from './typeable.js';

describe('toTypeable', () => {
  it.each([
    ['‘', "'"],
    ['’', "'"],
    ['‚', "'"],
    ['′', "'"],
    ['“', '"'],
    ['”', '"'],
    ['„', '"'],
    ['″', '"'],
    ['–', '-'],
    ['—', '-'],
    ['‒', '-'],
    ['−', '-'],
    ['…', '...'],
    [' ', ' '],
  ])('maps %j to %j', (from, to) => {
    expect(toTypeable(`a${from}b`)).toBe(`a${to}b`);
  });

  it('keeps printable ASCII as it is', () => {
    const ascii = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
      String.fromCharCode(0x20 + i),
    ).join('');
    expect(toTypeable(ascii)).toBe(ascii);
  });

  it('keeps a newline', () => {
    expect(toTypeable('one\ntwo')).toBe('one\ntwo');
  });

  it('refuses a letter it cannot type', () => {
    expect(toTypeable('café')).toBeNull();
  });

  it('refuses a tab, a carriage return and DEL', () => {
    expect(toTypeable('a\tb')).toBeNull();
    expect(toTypeable('a\r\nb')).toBeNull();
    expect(toTypeable('a\x7fb')).toBeNull();
  });

  it('refuses an emoji', () => {
    expect(toTypeable('ok \u{1f600}')).toBeNull();
  });

  it('maps an empty string to itself', () => {
    expect(toTypeable('')).toBe('');
  });
});
