import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  loadAnswerConfig,
  loadConfig,
  resolveRelayPort,
} from './config.js';

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

describe('resolveRelayPort', () => {
  it('reads a port set only in the file', () => {
    expect(resolveRelayPort({}, envFile('RUNNER_RELAY_PORT=9555\n'))).toBe(
      9555,
    );
  });
  it('defaults, lets env win, and rejects a bad value', () => {
    expect(resolveRelayPort({}, envFile(''))).toBe(9333);
    expect(
      resolveRelayPort(
        { RUNNER_RELAY_PORT: '9600' },
        envFile('RUNNER_RELAY_PORT=9555\n'),
      ),
    ).toBe(9600);
    expect(() =>
      resolveRelayPort({}, envFile('RUNNER_RELAY_PORT=nope\n')),
    ).toThrow(ConfigError);
  });
});

describe('loadAnswerConfig', () => {
  const none = join(tmpdir(), 'no-such-file');

  it('defaults to opus, opus, opus and one regeneration', () => {
    expect(loadAnswerConfig({}, none)).toEqual({
      answerModel: 'opus',
      verifyModel: 'opus',
      judgeModel: 'opus',
      maxRegenerations: 1,
    });
  });

  it('reads overrides from the file, and the environment wins', () => {
    const f = envFile(
      'ANSWER_MODEL=sonnet\nANSWER_VERIFY_MODEL=haiku\nANSWER_MAX_REGENERATIONS=3\n',
    );
    expect(loadAnswerConfig({ ANSWER_JUDGE_MODEL: 'fable' }, f)).toEqual({
      answerModel: 'sonnet',
      verifyModel: 'haiku',
      judgeModel: 'fable',
      maxRegenerations: 3,
    });
  });

  it('accepts 0 regenerations', () => {
    expect(
      loadAnswerConfig({ ANSWER_MAX_REGENERATIONS: '0' }, none)
        .maxRegenerations,
    ).toBe(0);
  });

  it('throws ConfigError for a bad ANSWER_MAX_REGENERATIONS', () => {
    for (const bad of ['4', '-1', '1.5', 'x']) {
      expect(() =>
        loadAnswerConfig({ ANSWER_MAX_REGENERATIONS: bad }, none),
      ).toThrow(ConfigError);
    }
  });
});
