import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.js';

function envFile(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'runner-env-test');
  writeFileSync(file, text);
  return file;
}

describe('loadConfig', () => {
  it('reads token and port from the file', () => {
    const f = envFile('RUNNER_BRIDGE_TOKEN=abc\nRUNNER_RELAY_PORT=9444\n');
    expect(loadConfig({}, f)).toEqual({ token: 'abc', relayPort: 9444 });
  });

  it('defaults the port to 9333', () => {
    expect(loadConfig({}, envFile('RUNNER_BRIDGE_TOKEN=abc\n'))).toEqual({
      token: 'abc',
      relayPort: 9333,
    });
  });

  it('lets the environment win over the file', () => {
    const f = envFile('RUNNER_BRIDGE_TOKEN=abc\n');
    expect(loadConfig({ RUNNER_BRIDGE_TOKEN: 'env' }, f).token).toBe('env');
  });

  it('throws ConfigError without a token', () => {
    const f = envFile('RUNNER_RELAY_PORT=9444\n');
    expect(() => loadConfig({}, f)).toThrow(ConfigError);
    expect(() => loadConfig({}, f)).toThrow(
      'no bridge token: run `pnpm nx run runner:bridge-install` first',
    );
    expect(() => loadConfig({}, join(tmpdir(), 'no-such-file'))).toThrow(
      ConfigError,
    );
  });

  it('rejects a bad port', () => {
    const f = envFile('RUNNER_BRIDGE_TOKEN=a\nRUNNER_RELAY_PORT=nope\n');
    expect(() => loadConfig({}, f)).toThrow(ConfigError);
  });
});
