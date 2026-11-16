import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config';
import supabasePack from '@prisma/orm-extension-supabase/pack';
import { loadDatabaseEnvironment } from './src/env/index.js';

// loadDatabaseEnvironment() refuses a non-local database, so every prisma
// command that loads this config is guarded.
const env = loadDatabaseEnvironment();

// Annotated so the declaration emit can name the type (TS2883).
const config: ReturnType<typeof definePrismaConfig> = definePrismaConfig({
  orm: ormConfig({
    contract: './src/contract/contract.prisma',
    extensions: [supabasePack],
    migrations: { dir: 'src/migrations' },
    db: {
      connection: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL,
    },
  }),
});

export default config;
