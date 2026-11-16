#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/6fef1dc7aa30f1b5f495cc8bf6353dc9f7c0238a8aace4439e07726613984d2e/contract';
import endContract from '../../snapshots/6fef1dc7aa30f1b5f495cc8bf6353dc9f7c0238a8aace4439e07726613984d2e/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  fn,
  primaryKey,
  rawSql,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'users',
        columns: [
          col('createdAt', 'timestamptz(3)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
          col('id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('updatedAt', 'timestamptz(3)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'users',
        foreignKey: {
          name: 'users_id_fkey',
          columns: ['id'],
          references: { schema: 'auth', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.enableRowLevelSecurity({ schema: 'public', table: 'users' }),
      this.createRlsPolicy({
        schema: 'public',
        table: 'users',
        policy: {
          naming: {
            kind: 'wire',
            prefix: 'users_owner_read',
            hash: 'b499dcb9',
          },
          tableName: 'users',
          namespaceId: 'public',
          operation: 'select',
          roles: ['authenticated'],
          using: sql`id = auth.uid()`,
          permissive: true,
        },
      }),
      this.createRlsPolicy({
        schema: 'public',
        table: 'users',
        policy: {
          naming: {
            kind: 'wire',
            prefix: 'users_owner_update',
            hash: '988f7d40',
          },
          tableName: 'users',
          namespaceId: 'public',
          operation: 'update',
          roles: ['authenticated'],
          using: sql`id = auth.uid()`,
          withCheck: sql`id = auth.uid()`,
          permissive: true,
        },
      }),
      // Every new auth user (signed up, created or invited) gets its users row
      // in the same transaction; EXECUTE is revoked so it only runs as the trigger.
      // The grants are explicit because Supabase projects no longer grant on new
      // public tables by default: authenticated reads and updates (RLS narrows
      // it to the own row), service_role gets everything, anon gets nothing.
      rawSql({
        id: 'trigger.on_auth_user_created',
        label: 'Create a users row for every new auth user',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'users' },
        },
        precheck: [],
        execute: [
          {
            description:
              'create handle_new_auth_user() and the on_auth_user_created trigger, and grant users to authenticated and service_role',
            sql: `CREATE FUNCTION public.handle_new_auth_user() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.users (id) VALUES (NEW.id);
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
GRANT SELECT, UPDATE ON public.users TO authenticated;
GRANT ALL ON public.users TO service_role;`,
          },
        ],
        postcheck: [],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
