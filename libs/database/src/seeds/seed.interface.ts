import type { SeedEnvironmentVariables } from '../env/index.js';

/**
 * @description A seed must be idempotent: running the seeds twice leaves the
 * database in the same state. It logs one line saying what it did.
 */
export interface Seed {
  name: string;
  run(
    env: SeedEnvironmentVariables,
    log: (message: string) => void,
  ): Promise<void>;
}
