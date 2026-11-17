import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabaseClient, type DatabaseClient } from '@xapply/database';

export const DATABASE_URL = Symbol('DATABASE_URL');

/** Bounded so a dead database fails a health check fast instead of hanging. */
export const CONNECTION_TIMEOUT_MS = 5000;
export const IDLE_TIMEOUT_MS = 30000;

/** Owns the single database client for the API. */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly db: DatabaseClient;

  constructor(@Inject(DATABASE_URL) url: string) {
    this.db = createDatabaseClient({
      url,
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
  }

  /** Round-trips a trivial statement; used by the health check. */
  async ping(): Promise<void> {
    await this.db.execute(this.db.raw.sql`SELECT 1`.affectedCount().build());
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
