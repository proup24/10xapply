import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withCatalog } from './support/pg.js';
import {
  cleanupTestUsers,
  createTestUser,
  type TestUser,
} from './support/test-users.js';

// The engine's own tables: only service_role touches them. A signed-in user
// has no grant, so a read or a write is refused outright (42501).

afterAll(cleanupTestUsers);

let a: TestUser;

const seeds: Record<string, string> = {
  intake_links: `INSERT INTO public.intake_links ("userId", "tokenHash", secret)
                 VALUES ($1, $2, 's')`,
  webhook_deliveries: `INSERT INTO public.webhook_deliveries
                 ("userId", "deliveryId", event, "sentAt", "rawBody", outcome)
                 VALUES ($1, $2, 'match', now(), '{}', 'match')`,
};

const payloads: Record<string, (userId: string) => Record<string, unknown>> = {
  intake_links: (userId) => ({
    userId,
    tokenHash: randomUUID(),
    secret: 's',
  }),
  webhook_deliveries: (userId) => ({
    userId,
    deliveryId: randomUUID(),
    event: 'match',
    sentAt: new Date().toISOString(),
    rawBody: '{}',
    outcome: 'match',
  }),
};

beforeAll(async () => {
  a = await createTestUser();
});

it.each(['intake_links', 'webhook_deliveries'])(
  'a signed-in user reads no rows and cannot insert into %s',
  async (table) => {
    await withCatalog((client) =>
      client.query(seeds[table], [a.id, randomUUID()]),
    );

    const read = await a.client.from(table).select('*');
    expect(read.error?.code).toBe('42501');

    const insert = await a.client.from(table).insert(payloads[table](a.id));
    expect(insert.error?.code).toBe('42501');
  },
);
