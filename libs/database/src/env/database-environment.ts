import { z } from 'zod';
import { assertLocalDatabase, captureRemoteOptIn } from './local-guard.js';
import { loadEnvironmentFiles } from './environment.loader.js';

/**
 * @description Environment variables are strings; this parses the usual
 * spellings of a boolean instead of treating every non-empty string as `true`.
 */
export const booleanFlag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => ['true', '1', 'yes'].includes(value));

const postgresUrl = z
  .url({ protocol: /^postgres(ql)?$/ })
  .describe('postgresql://user:password@host:port/database');

/**
 * @description Variables needed to reach the database. Kept separate so the
 * Prisma CLI config and the seed runner can validate only what they use,
 * without requiring the HTTP server's settings in CI.
 */
export const databaseEnvironmentSchema = z.object({
  /**
   * Runtime connection. On Supabase use the session pooler (port 5432) or the
   * direct connection — never the transaction pooler (6543), which breaks
   * session-level settings the Prisma 8 runtime relies on.
   */
  DATABASE_URL: postgresUrl,
  /** Optional connection for migrations; falls back to `DATABASE_URL`. */
  DIRECT_DATABASE_URL: postgresUrl.optional(),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(20_000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DATABASE_SLOW_QUERY_MS: z.coerce.number().int().nonnegative().default(500),
  DATABASE_LOG_QUERIES: booleanFlag.default(false),
});

/** What the seed runner reads: the database plus the Supabase admin API. */
export const seedEnvironmentSchema = databaseEnvironmentSchema.extend({
  /** The users seed creates auth users through the Supabase admin API. */
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
});

export type DatabaseEnvironmentVariables = z.infer<
  typeof databaseEnvironmentSchema
>;
export type SeedEnvironmentVariables = z.infer<typeof seedEnvironmentSchema>;

/**
 * @description Parses `config` against `schema`, failing with every invalid
 * variable listed at once rather than the first one only.
 */
export function parseEnvironment<T extends z.ZodType>(
  schema: T,
  config: Record<string, unknown>,
): z.infer<T> {
  const result = schema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * @description For code running outside Nest (Prisma config, scripts): loads
 * the env files and validates only the database variables. Refuses a
 * non-local database unless the opt-in was set before any env file loaded.
 */
export function loadDatabaseEnvironment(
  start?: string,
): DatabaseEnvironmentVariables {
  const optIn = captureRemoteOptIn(process.env);
  loadEnvironmentFiles(start);
  const env = parseEnvironment(databaseEnvironmentSchema, process.env);
  assertLocalDatabase(
    {
      DATABASE_URL: env.DATABASE_URL,
      DIRECT_DATABASE_URL: env.DIRECT_DATABASE_URL,
    },
    optIn,
  );
  return env;
}

/**
 * @description For the seed runner: like `loadDatabaseEnvironment`, plus the
 * optional Supabase admin variables. Guarded the same way.
 */
export function loadSeedEnvironment(start?: string): SeedEnvironmentVariables {
  const optIn = captureRemoteOptIn(process.env);
  loadEnvironmentFiles(start);
  const env = parseEnvironment(seedEnvironmentSchema, process.env);
  assertLocalDatabase(
    {
      DATABASE_URL: env.DATABASE_URL,
      DIRECT_DATABASE_URL: env.DIRECT_DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
    },
    optIn,
  );
  return env;
}
