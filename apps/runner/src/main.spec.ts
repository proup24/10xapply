import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './main.js';

afterEach(() => vi.restoreAllMocks());

describe('main answers eval flags', () => {
  it('refuses the --flag=value form and exits 1 without running', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['answers', 'eval', '--set=example'])).toBe(1);
    expect(err.mock.calls.join('\n')).toContain('--set <value>');
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects an unknown set value and exits 1', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['answers', 'eval', '--set', 'other'])).toBe(1);
    expect(err.mock.calls.join('\n')).toContain(
      '--set must be example or private',
    );
  });
});
