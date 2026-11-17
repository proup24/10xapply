import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DEFAULT_URL = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The local Supabase database URL for the API's db tests. Refuses anything
 * that is not the local stack's database (127.0.0.1, port 55322): these tests
 * insert users, so they must never reach the cloud project or 10xjobs's stack.
 */
export function localDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'] ?? DEFAULT_URL;
  const { hostname, port } = new URL(url);
  if (!LOCAL_HOSTS.has(hostname) || port !== '55322') {
    throw new Error(
      `Refusing to run the API db tests against ${hostname}:${port || 'default'}: they only run against the local stack's database on 127.0.0.1 port 55322.`,
    );
  }
  return url;
}

/**
 * Inserts an auth.users row, so the on_auth_user_created trigger creates the
 * public.users row, and returns the new user's id.
 */
export async function createTestUser(): Promise<string> {
  const id = randomUUID();
  const client = new pg.Client({ connectionString: localDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      'INSERT INTO auth.users (id, email, aud, role) VALUES ($1, $2, $3, $4)',
      [id, `api-db-test-${id}@example.test`, 'authenticated', 'authenticated'],
    );
  } finally {
    await client.end();
  }
  return id;
}
