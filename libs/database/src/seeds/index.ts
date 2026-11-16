/**
 * Seed runner — Prisma 8 has no built-in seed command.
 *
 *   pnpm db:seed                    run every seed, in order
 *   pnpm db:seed --only users       run the named seeds
 *
 * Seeds are local-only; CI never seeds the cloud project.
 * loadSeedEnvironment() refuses a non-local DATABASE_URL, DIRECT_DATABASE_URL
 * or SUPABASE_URL. Every seed must be idempotent.
 */
import { pathToFileURL } from 'node:url';
import { loadSeedEnvironment } from '../env/index.js';
import type { Seed } from './seed.interface.js';
import { usersSeed } from './users.seed.js';

/** Order matters: seeds run sequentially, so list parents before children. */
const seeds: Seed[] = [usersSeed];

function parseArgs(argv: string[]) {
  const onlyIndex = argv.indexOf('--only');
  const only =
    onlyIndex === -1
      ? undefined
      : argv[onlyIndex + 1]?.split(',').filter(Boolean);
  return { only };
}

function log(message: string): void {
  console.log(`[Seed] ${message}`);
}

async function main(): Promise<void> {
  const { only } = parseArgs(process.argv.slice(2));
  const env = loadSeedEnvironment();

  const unknown = only?.filter(
    (name) => !seeds.some((seed) => seed.name === name),
  );
  if (unknown?.length) {
    throw new Error(`Unknown seed(s): ${unknown.join(', ')}`);
  }
  const selected = only
    ? seeds.filter((seed) => only.includes(seed.name))
    : seeds;

  for (const seed of selected) {
    const startedAt = Date.now();
    await seed.run(env, log);
    log(`${seed.name} seeded in ${Date.now() - startedAt}ms`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(`[Seed] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
