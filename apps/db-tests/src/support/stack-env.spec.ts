import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync }));

import { assertLocal, loadStackEnv } from './stack-env.js';

const KEYS = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

describe('assertLocal', () => {
  it('refuses 10xjobs local ports and remote hosts', () => {
    expect(() =>
      assertLocal('postgresql://postgres:postgres@127.0.0.1:54322/postgres'),
    ).toThrow();
    expect(() => assertLocal('http://127.0.0.1:54321')).toThrow();
    expect(() => assertLocal('https://abc.supabase.co')).toThrow();
    expect(() =>
      assertLocal('postgresql://postgres:postgres@127.0.0.1:55322/postgres'),
    ).not.toThrow();
    expect(() => assertLocal('http://127.0.0.1:55321')).not.toThrow();
  });

  it('names the host and port but never the credentials', () => {
    expect(() =>
      assertLocal('postgresql://postgres:hunter2@db.example.com:5432/postgres'),
    ).toThrow(/db\.example\.com/);
    expect(() =>
      assertLocal('postgresql://postgres:hunter2@db.example.com:5432/postgres'),
    ).not.toThrow(/hunter2/);
  });
});

describe('loadStackEnv', () => {
  beforeEach(() => {
    execFileSync.mockReset();
    for (const key of KEYS) vi.stubEnv(key, undefined as unknown as string);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the three env vars when all are set', () => {
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:55321');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'pub');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');

    expect(loadStackEnv()).toEqual({
      url: 'http://127.0.0.1:55321',
      publishableKey: 'pub',
      serviceRoleKey: 'service',
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('throws naming pnpm db:start when env is unset and the CLI fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('stack is down');
    });

    expect(() => loadStackEnv()).toThrow(/pnpm db:start/);
  });

  it('keeps the CLI failure as the error cause', () => {
    const failure = new Error('stack is down');
    execFileSync.mockImplementation(() => {
      throw failure;
    });

    expect(() => loadStackEnv()).toThrow(
      expect.objectContaining({ cause: failure }),
    );
  });

  it('refuses a non-local host from the environment', () => {
    vi.stubEnv('SUPABASE_URL', 'https://abc.supabase.co');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'pub');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
    expect(() => loadStackEnv()).toThrow(/abc\.supabase\.co/);
  });

  it("refuses 10xjobs's local stack", () => {
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'pub');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
    expect(() => loadStackEnv()).toThrow(/54321/);
  });
});
