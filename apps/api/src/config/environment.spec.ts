import { loadEnvironment } from './environment';

const key = 'k'.repeat(32);

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
    expect(loadEnvironment({ API_KEY: key })).toEqual({
      API_KEY: key,
      PORT: 3000,
      NODE_ENV: 'development',
    });
  });

  it('rejects a missing API_KEY, and the message names API_KEY', () => {
    expect(messageOf({})).toContain('API_KEY');
  });

  it('rejects a 31-char API_KEY', () => {
    expect(() => loadEnvironment({ API_KEY: 'k'.repeat(31) })).toThrow(
      /API_KEY/,
    );
  });

  it('rejects an API_KEY with surrounding whitespace or a trailing \\r', () => {
    expect(() => loadEnvironment({ API_KEY: `${key}\r` })).toThrow(/API_KEY/);
    expect(() => loadEnvironment({ API_KEY: ` ${key}` })).toThrow(/API_KEY/);
    expect(() => loadEnvironment({ API_KEY: `${key} ` })).toThrow(/API_KEY/);
  });

  it('the error message never contains the key value', () => {
    expect(messageOf({ API_KEY: 'k'.repeat(31) })).not.toContain('kkkk');
  });
});
