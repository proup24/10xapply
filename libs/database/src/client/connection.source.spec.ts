import { vi } from 'vitest';
import { assertLocalDatabase } from '../env/local-guard.js';
import { createDatabaseClient } from './connection.source.js';

vi.mock('../env/local-guard.js');

describe('createDatabaseClient', () => {
  it('creates a client for a remote URL without throwing or connecting', async () => {
    const client = createDatabaseClient({
      url: 'postgresql://u:p@db.example.com:5432/postgres',
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    });
    expect(typeof client.transaction).toBe('function');
    expect(typeof client.execute).toBe('function');
    await client.close();
  });

  it('never calls the local-only guard', () => {
    expect(assertLocalDatabase).not.toHaveBeenCalled();
  });
});
