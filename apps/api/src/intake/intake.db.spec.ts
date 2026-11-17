import { createDatabaseClient } from '@xapply/database';
import { localDatabaseUrl } from './testing/local-db';

describe('local stack', () => {
  it('local stack answers SELECT 1', async () => {
    const db = createDatabaseClient({
      url: localDatabaseUrl(),
      connectionTimeoutMs: 5000,
      idleTimeoutMs: 1000,
    });
    try {
      await db.execute(db.raw.sql`SELECT 1`.affectedCount().build());
    } finally {
      await db.close();
    }
  });
});
