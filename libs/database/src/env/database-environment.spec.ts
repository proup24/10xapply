import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import {
  loadDatabaseEnvironment,
  loadSeedEnvironment,
} from './database-environment.js';
import {
  loadEnvironmentFiles,
  resetEnvironmentLoaderForTests,
} from './environment.loader.js';

const KEYS = [
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'XAPPLY_ALLOW_REMOTE_DB',
  'XAPPLY_SKIP_ENV_FILES',
  'SUPABASE_URL',
];
const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

describe('database environment', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  const writeEnv = (content: string) =>
    writeFileSync(join(dir, '.env'), content);

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), 'xapply-env-'));
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), '');
    resetEnvironmentLoaderForTests();
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
    resetEnvironmentLoaderForTests();
  });

  it('ignores XAPPLY_ALLOW_REMOTE_DB=1 written in .env', () => {
    writeEnv(
      'DATABASE_URL=postgresql://u:p@db.example.com:5432/postgres\nXAPPLY_ALLOW_REMOTE_DB=1\n',
    );
    expect(() => loadDatabaseEnvironment(dir)).toThrow(
      /non-local host db\.example\.com/,
    );
  });

  it('allows a remote URL when the opt-in is set in the process', () => {
    process.env.XAPPLY_ALLOW_REMOTE_DB = '1';
    writeEnv('DATABASE_URL=postgresql://u:p@db.example.com:5432/postgres\n');
    expect(loadDatabaseEnvironment(dir).DATABASE_URL).toContain(
      'db.example.com',
    );
  });

  it('returns local URLs unchanged', () => {
    writeEnv(`DATABASE_URL=${LOCAL}\n`);
    const env = loadDatabaseEnvironment(dir);
    expect(env.DATABASE_URL).toBe(LOCAL);
    expect(env.DIRECT_DATABASE_URL).toBeUndefined();
  });

  it('guards a remote DIRECT_DATABASE_URL', () => {
    writeEnv(
      `DATABASE_URL=${LOCAL}\nDIRECT_DATABASE_URL=postgresql://u:p@db.example.com:5432/x\n`,
    );
    expect(() => loadDatabaseEnvironment(dir)).toThrow(
      /DIRECT_DATABASE_URL at non-local host db\.example\.com/,
    );
  });

  it('guards the seed environment and keeps the Supabase variables', () => {
    writeEnv(`DATABASE_URL=${LOCAL}\nSUPABASE_URL=http://127.0.0.1:55321\n`);
    expect(loadSeedEnvironment(dir).SUPABASE_URL).toBe(
      'http://127.0.0.1:55321',
    );
    resetEnvironmentLoaderForTests();
    delete process.env.DATABASE_URL;
    delete process.env.SUPABASE_URL;
    writeEnv('DATABASE_URL=postgresql://u:p@db.example.com:5432/x\n');
    expect(() => loadSeedEnvironment(dir)).toThrow(/non-local host/);
  });

  it('loads no env file when XAPPLY_SKIP_ENV_FILES=1', () => {
    process.env.XAPPLY_SKIP_ENV_FILES = '1';
    writeEnv(`DATABASE_URL=${LOCAL}\n`);
    loadEnvironmentFiles(dir);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it('does not let a .env opt-in leak across calls or into process.env', () => {
    writeEnv(
      'DATABASE_URL=postgresql://u:p@db.example.com:5432/postgres\nXAPPLY_ALLOW_REMOTE_DB=1\n',
    );
    expect(() => loadDatabaseEnvironment(dir)).toThrow(/non-local host/);
    expect(process.env.XAPPLY_ALLOW_REMOTE_DB).toBeUndefined();
    expect(() => loadDatabaseEnvironment(dir)).toThrow(/non-local host/);
    expect(() => loadSeedEnvironment(dir)).toThrow(/non-local host/);
    resetEnvironmentLoaderForTests();
    expect(() => loadSeedEnvironment(dir)).toThrow(/non-local host/);
  });

  it('refuses a remote SUPABASE_URL beside a local DATABASE_URL', () => {
    writeEnv(`DATABASE_URL=${LOCAL}\nSUPABASE_URL=https://abc.supabase.co\n`);
    expect(() => loadSeedEnvironment(dir)).toThrow(
      /SUPABASE_URL at non-local host abc\.supabase\.co/,
    );
  });
});
