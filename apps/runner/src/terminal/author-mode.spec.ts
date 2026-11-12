import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { InputClosedError, isAuthorMode, nodeTerminal } from './author-mode.js';

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

describe('nodeTerminal', () => {
  it('ask resolves with the typed line', async () => {
    const input = new PassThrough();
    const io = nodeTerminal({ input, output: new PassThrough() });
    const p = io.ask('? ');
    input.write('yes\n');
    await expect(p).resolves.toBe('yes');
  });

  it('ask rejects on end of input instead of waiting forever', async () => {
    const input = new PassThrough();
    const io = nodeTerminal({ input, output: new PassThrough() });
    const p = io.ask('? ');
    input.end();
    await expect(p).rejects.toBeInstanceOf(InputClosedError);
  });

  it('Ctrl+C at a prompt reaches the process as SIGINT and ask rejects', async () => {
    const input = new PassThrough();
    // A TTY-like output puts readline in terminal mode, where \x03 is Ctrl+C.
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
    });
    const got: string[] = [];
    const onSigint = (sig: string) => void got.push(sig);
    process.on('SIGINT', onSigint);
    try {
      const io = nodeTerminal({ input, output });
      const p = io.ask('? ');
      input.write('\x03');
      await expect(p).rejects.toBeInstanceOf(InputClosedError);
      expect(got).toEqual(['SIGINT']);
    } finally {
      process.off('SIGINT', onSigint);
    }
  });
});
