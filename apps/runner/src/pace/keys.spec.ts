import { needsShift, physicalKey } from './keys.js';

describe('keys (US layout)', () => {
  it('knows which characters take Shift', () => {
    for (const ch of ['A', 'Z', '!', '@', '?', '"', '~', '_']) {
      expect(needsShift(ch), ch).toBe(true);
    }
    for (const ch of ['a', 'z', '1', '2', '/', "'", '`', '-', ' ', 'é']) {
      expect(needsShift(ch), ch).toBe(false);
    }
  });

  it('maps a character to its physical key', () => {
    expect(physicalKey('A')).toBe('a');
    expect(physicalKey('!')).toBe('1');
    expect(physicalKey('@')).toBe('2');
    expect(physicalKey('?')).toBe('/');
    expect(physicalKey('a')).toBe('a');
    expect(physicalKey('1')).toBe('1');
    expect(physicalKey('é')).toBe('é');
  });
});
