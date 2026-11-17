import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './create-app';
import { loadEnvironment } from './config/environment';

/**
 * Finds `.env.local` next to the app root (the bundle lives in `dist/`), so it
 * resolves the same from any working directory; falls back to the workspace
 * layout relative to cwd.
 */
function envFile(): string | undefined {
  return [
    join(__dirname, '..', '.env.local'),
    join(process.cwd(), 'apps/api/.env.local'),
  ].find((path) => existsSync(path));
}

async function bootstrap(): Promise<void> {
  if (process.env.XAPPLY_SKIP_ENV_FILES !== '1') {
    const file = envFile();
    if (file) process.loadEnvFile(file);
  }
  const env = loadEnvironment(process.env);
  const app = await createApp(env);
  await app.listen(env.PORT, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  // Message only: never the environment or any value.
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`API failed to start: ${message}\n`);
  process.exit(1);
});
