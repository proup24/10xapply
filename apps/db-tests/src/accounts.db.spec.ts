import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { admin } from './support/admin.js';
import { cleanupTestUsers, createTestUser } from './support/test-users.js';

afterAll(cleanupTestUsers);

async function countUsers(id: string): Promise<number | null> {
  const { count, error } = await admin()
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('id', id);
  if (error) throw new Error(`Could not count users: ${error.message}`);
  return count;
}

describe('accounts', () => {
  it('a new auth user gets exactly one users row with createdAt set', async () => {
    const a = await createTestUser();
    const { data, error } = await admin()
      .from('users')
      .select('id, createdAt')
      .eq('id', a.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.id).toBe(a.id);
    expect(data?.[0]?.createdAt).toEqual(expect.any(String));
  });

  it('deleting the auth user removes their users row', async () => {
    const a = await createTestUser();
    expect(await countUsers(a.id)).toBe(1);

    const { error } = await admin().auth.admin.deleteUser(a.id);
    expect(error).toBeNull();

    expect(await countUsers(a.id)).toBe(0);
  });

  it('a user cannot insert a second users row or delete their own', async () => {
    const a = await createTestUser();
    const stray = randomUUID();
    const inserted = await a.client.from('users').insert({ id: stray });
    expect(inserted.error?.code).toBe('42501');
    expect(await countUsers(stray)).toBe(0);

    await a.client.from('users').delete().eq('id', a.id);
    expect(await countUsers(a.id)).toBe(1);
  });
});
