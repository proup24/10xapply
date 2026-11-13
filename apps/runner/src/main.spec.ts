import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './main.js';
import { disqualifyEvalCommand } from './commands/disqualify.js';

vi.mock('./commands/disqualify.js', () => ({
  disqualifyEvalCommand: vi.fn(async () => 0),
}));

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

describe('main disqualify eval', () => {
  it('dispatches with the parsed flags', async () => {
    expect(
      await main([
        'disqualify',
        'eval',
        '--repeat',
        '2',
        '--model',
        'sonnet',
        '--case',
        'auth-us',
      ]),
    ).toBe(0);
    expect(disqualifyEvalCommand).toHaveBeenCalledWith({
      repeat: 2,
      model: 'sonnet',
      caseId: 'auth-us',
    });
  });

  it('refuses the --flag=value form', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['disqualify', 'eval', '--repeat=2'])).toBe(1);
  });
});
