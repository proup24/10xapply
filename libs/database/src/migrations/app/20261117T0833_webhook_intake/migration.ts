#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/6fef1dc7aa30f1b5f495cc8bf6353dc9f7c0238a8aace4439e07726613984d2e/contract';
import startContract from '../../snapshots/6fef1dc7aa30f1b5f495cc8bf6353dc9f7c0238a8aace4439e07726613984d2e/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/ae52dc93d2bdc83a4eb750d1fd4c4b424ecf2e1dad1d6cf44c100ef19fe118c8/contract';
import endContract from '../../snapshots/ae52dc93d2bdc83a4eb750d1fd4c4b424ecf2e1dad1d6cf44c100ef19fe118c8/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
  rawSql,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'intake_links',
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
            default: fn(sql`gen_random_uuid()`),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('secret', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('tokenHash', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz(3)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
          col('userId', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'matches',
        columns: [
          col('applyUrl', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('companyName', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('createdAt', 'timestamptz(3)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
          col('deliveryId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn(sql`gen_random_uuid()`),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('jobKey', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('linkedinJobId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('matchedAt', 'timestamptz(3)', {
            notNull: true,
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
          col('postingUrl', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('profileLabel', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('new'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('title', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('unverified', 'bool', {
            notNull: true,
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('updatedAt', 'timestamptz(3)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
          col('userId', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('xjobsJobId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'matches_status_check_7a4128ff',
            sql`"status" IN ('new')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'webhook_deliveries',
        columns: [
          col('createdAt', 'timestamptz(3)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
          col('deliveryId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('event', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn(sql`gen_random_uuid()`),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('outcome', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('rawBody', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('sentAt', 'timestamptz(3)', {
            notNull: true,
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
          col('updatedAt', 'timestamptz(3)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: {
              codecId: 'pg/timestamptz-date@1',
              typeParams: { precision: 3 },
            },
          }),
          col('userId', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'webhook_deliveries_outcome_check_69f9d3b2',
            sql`"outcome" IN ('match', 'duplicate-job', 'test', 'unparsed')`,
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'intake_links',
        constraint: 'intake_links_userId_key',
        columns: ['userId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'intake_links',
        constraint: 'intake_links_tokenHash_key',
        columns: ['tokenHash'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'matches',
        constraint: 'matches_userId_xjobsJobId_key',
        columns: ['userId', 'xjobsJobId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'matches',
        constraint: 'matches_userId_linkedinJobId_key',
        columns: ['userId', 'linkedinJobId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'webhook_deliveries',
        constraint: 'webhook_deliveries_userId_deliveryId_key',
        columns: ['userId', 'deliveryId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'matches',
        index: 'matches_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'webhook_deliveries',
        index: 'webhook_deliveries_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'intake_links',
        foreignKey: {
          name: 'intake_links_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'matches',
        foreignKey: {
          name: 'matches_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'webhook_deliveries',
        foreignKey: {
          name: 'webhook_deliveries_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.enableRowLevelSecurity({ schema: 'public', table: 'intake_links' }),
      this.enableRowLevelSecurity({ schema: 'public', table: 'matches' }),
      this.enableRowLevelSecurity({
        schema: 'public',
        table: 'webhook_deliveries',
      }),
      this.createRlsPolicy({
        schema: 'public',
        table: 'matches',
        policy: {
          naming: {
            kind: 'wire',
            prefix: 'matches_owner_read',
            hash: 'ab58a1a7',
          },
          tableName: 'matches',
          namespaceId: 'public',
          operation: 'select',
          roles: ['authenticated'],
          using: sql`"userId" = auth.uid()`,
          permissive: true,
        },
      }),
      // Nothing is granted by default (see tighten_users_grants): authenticated reads
      // its own matches (RLS narrows it), the engine tables stay service-role only.
      rawSql({
        id: 'grants.webhook_intake',
        label:
          'Grant matches to authenticated and service_role; the intake tables to service_role',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'matches' },
        },
        precheck: [],
        execute: [
          {
            description: 'grant the webhook intake tables',
            sql: `GRANT SELECT ON public.matches TO authenticated;
GRANT ALL ON public.matches, public.intake_links, public.webhook_deliveries TO service_role;`,
          },
        ],
        postcheck: [],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
