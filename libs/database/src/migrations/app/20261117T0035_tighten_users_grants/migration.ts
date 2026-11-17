#!/usr/bin/env -S node
import type {
  Contract as End,
  Contract as Start,
} from '../../snapshots/6fef1dc7aa30f1b5f495cc8bf6353dc9f7c0238a8aace4439e07726613984d2e/contract';
import endContract from '../../snapshots/6fef1dc7aa30f1b5f495cc8bf6353dc9f7c0238a8aace4439e07726613984d2e/contract.json' with { type: 'json' };
import startContract from '../../snapshots/6fef1dc7aa30f1b5f495cc8bf6353dc9f7c0238a8aace4439e07726613984d2e/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  rawSql,
} from '@prisma/orm-postgres/migration';

// NOTE: this migration changes no contract (same start and end hash), so the
// `tighten-users-grants` invariant in ../refs/db.json decides whether it runs.
// Advancing the `db` ref writes `invariants: []`; re-add it.
//
// The cloud project's default privileges on `public` gave anon, authenticated
// and service_role every table privilege on top of init_users' grants, TRUNCATE
// (which RLS does not cover) included. This takes users back to init_users'
// intent, and stops tables that migrations create later (they run as postgres)
// from picking up anything by default: each table grants what it needs itself.

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // operationClass is 'data' because the contract does not change: the planner
      // rejects a same-hash migration with no data op.
      rawSql({
        id: 'grants.tighten_users',
        invariantId: 'tighten-users-grants',
        label:
          'Users: anon nothing, authenticated select and update; no default table grants in public',
        operationClass: 'data',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'users' },
        },
        precheck: [],
        execute: [
          {
            description: 'reset the grants on users',
            sql: `REVOKE ALL ON public.users FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.users TO authenticated;
GRANT ALL ON public.users TO service_role;`,
          },
          {
            description:
              'stop new tables and sequences in public granting anon and authenticated by default',
            sql: `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;`,
          },
        ],
        postcheck: [],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
