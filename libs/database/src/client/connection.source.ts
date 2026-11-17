import supabaseRuntimeDescriptor from '@prisma/orm-extension-supabase/runtime';
import postgres, { type PostgresClient } from '@prisma/orm-postgres/runtime';
import { contractFromJson } from '@prisma/orm-postgres/static';
import type { Contract } from '../contract/contract.d.js';
import contractJson from '../contract/contract.json' with { type: 'json' };

export const contract = contractFromJson<Contract>(contractJson);

export interface DatabaseClientConfig {
  url: string;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
}

export type DatabaseClient = PostgresClient<Contract>;
export type DatabaseTransaction = Parameters<
  Parameters<DatabaseClient['transaction']>[0]
>[0];

/**
 * @description Builds the Prisma 8 client. The client connects lazily: the
 * pool opens its first connection on the first query, so this never blocks.
 * A server keeps one client for the process lifetime; scripts must call
 * `close()` when done. No log or middleware is installed, so no SQL or
 * values reach any log. It never calls `assertLocalDatabase`: the API runs
 * against the cloud project.
 */
export function createDatabaseClient(
  config: DatabaseClientConfig,
): DatabaseClient {
  return postgres({
    contract,
    url: config.url,
    extensions: [supabaseRuntimeDescriptor],
    poolOptions: {
      connectionTimeoutMillis: config.connectionTimeoutMs,
      idleTimeoutMillis: config.idleTimeoutMs,
    },
  });
}
