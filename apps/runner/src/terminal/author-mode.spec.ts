import { describe, expect, it } from 'vitest';
import { isAuthorMode } from './author-mode.js';

describe('isAuthorMode', () => {
  it('is true with both TTYs and no CLAUDECODE', () => {
    expect(isAuthorMode({}, true, true)).toBe(true);
  });
  it('is false under Claude Code', () => {
    expect(isAuthorMode({ CLAUDECODE: '1' }, true, true)).toBe(false);
  });
  it('is false when either TTY is missing', () => {
    expect(isAuthorMode({}, false, true)).toBe(false);
    expect(isAuthorMode({}, true, false)).toBe(false);
  });
});
