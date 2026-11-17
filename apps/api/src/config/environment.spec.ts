import { loadEnvironment } from './environment';

const key = 'k'.repeat(32);
const url = 'postgresql://u:p@127.0.0.1:5432/db';

function messageOf(env: NodeJS.ProcessEnv): string {
  try {
    loadEnvironment(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadEnvironment to throw');
}

describe('loadEnvironment', () => {
  it('accepts a 32-char key and defaults PORT to 3000 and NODE_ENV to development', () => {
    expect(loadEnvironment({ API_KEY: key, DATABASE_URL: url })).toEqual({
      API_KEY: key,
      DATABASE_URL: url,
      PORT: 3000,
      NODE_ENV: 'development',
    });
  });

  it('rejects a missing API_KEY, and the message names API_KEY', () => {
    expect(messageOf({})).toContain('API_KEY');
  });

  it('rejects a 31-char API_KEY', () => {
    expect(() =>
      loadEnvironment({ API_KEY: 'k'.repeat(31), DATABASE_URL: url }),
    ).toThrow(/API_KEY/);
  });

  it('rejects an API_KEY with surrounding whitespace or a trailing \\r', () => {
    expect(() =>
      loadEnvironment({ API_KEY: `${key}\r`, DATABASE_URL: url }),
    ).toThrow(/API_KEY/);
    expect(() =>
      loadEnvironment({ API_KEY: ` ${key}`, DATABASE_URL: url }),
    ).toThrow(/API_KEY/);
    expect(() =>
      loadEnvironment({ API_KEY: `${key} `, DATABASE_URL: url }),
    ).toThrow(/API_KEY/);
  });

  it('the error message never contains the key value', () => {
    expect(
      messageOf({ API_KEY: 'k'.repeat(31), DATABASE_URL: url }),
    ).not.toContain('kkkk');
    const padded = `${'k'.repeat(39)}\r`;
    expect(padded).toHaveLength(40);
    const message = messageOf({ API_KEY: padded, DATABASE_URL: url });
    expect(message).toContain('API_KEY');
    expect(message).not.toContain('kkkk');
  });

  it('requires DATABASE_URL', () => {
    expect(messageOf({ API_KEY: key })).toContain('DATABASE_URL');
  });

  it('refuses a non-postgres URL without echoing it', () => {
    const message = messageOf({
      API_KEY: key,
      DATABASE_URL: 'https://u:hunter2@x',
    });
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('hunter2');
  });
});
