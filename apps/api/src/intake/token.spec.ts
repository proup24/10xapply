import { describe, expect, it } from 'vitest';
import { hashToken } from './token';

describe('hashToken', () => {
  it('is the SHA-256 hex of the token', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
