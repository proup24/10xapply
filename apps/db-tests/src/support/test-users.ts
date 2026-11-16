import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { admin, noSession, stack } from './admin.js';

export type TestUser = {
  id: string;
  email: string;
  password: string;
  client: SupabaseClient;
};

const createdIds = new Set<string>();

export async function createTestUser(): Promise<TestUser> {
  const { url, publishableKey } = stack();
  const email = `db-test-${randomUUID()}@xapply.test`;
  const password = randomUUID();

  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Could not create test user: ${error.message}`);
  createdIds.add(data.user.id);

  const client = createClient(url, publishableKey, noSession);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error)
    throw new Error(`Could not sign in test user: ${signedIn.error.message}`);

  return { id: data.user.id, email, password, client };
}

export async function cleanupTestUsers(): Promise<void> {
  if (createdIds.size === 0) return;
  const client = admin();
  for (const id of [...createdIds]) {
    const { error } = await client.auth.admin.deleteUser(id);
    if (error && !/not found/i.test(error.message)) {
      throw new Error(`Could not delete test user ${id}: ${error.message}`);
    }
    createdIds.delete(id);
  }
}
