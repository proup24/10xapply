import { expect, it } from 'vitest';
import { withCatalog } from './support/pg.js';

// Each table grants what it needs in its own migration. RLS hides rows but not
// TRUNCATE, and the cloud project's default privileges once handed anon and
// authenticated everything, so the grants are checked here, not assumed.

/** The table privileges authenticated may hold. Add a table when it needs one. */
const AUTHENTICATED: Record<string, string[]> = {
  matches: ['SELECT'],
  users: ['SELECT', 'UPDATE'],
};

const grantsTo = (role: string) =>
  withCatalog(async (client) => {
    const { rows } = await client.query<{ table: string; privilege: string }>(
      `SELECT table_name AS table, privilege_type AS privilege
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = $1
        ORDER BY table_name, privilege_type`,
      [role],
    );
    const byTable: Record<string, string[]> = {};
    for (const { table, privilege } of rows) {
      (byTable[table] ??= []).push(privilege);
    }
    return byTable;
  });

it('grants anon nothing on any table in public', async () => {
  expect(await grantsTo('anon')).toEqual({});
});

it('grants authenticated only the listed privileges', async () => {
  expect(await grantsTo('authenticated')).toEqual(AUTHENTICATED);
});

it('gives new tables and sequences in public no default grants to anon or authenticated', async () => {
  const entries = await withCatalog(async (client) => {
    const { rows } = await client.query<{ acl: string }>(
      `SELECT d.defaclacl::text AS acl
         FROM pg_default_acl d
         JOIN pg_namespace n ON n.oid = d.defaclnamespace
         JOIN pg_roles r ON r.oid = d.defaclrole
        WHERE n.nspname = 'public'
          AND r.rolname = 'postgres'
          AND d.defaclobjtype IN ('r', 'S')`,
    );
    return rows.map((r) => r.acl);
  });
  for (const acl of entries) {
    expect(acl).not.toMatch(/\b(anon|authenticated)=/);
  }
});
