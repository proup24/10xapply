import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvironment } from './config/environment';

// Task 3 wires createApp; for now the bootstrap only loads and validates env.
function bootstrap(): void {
  if (process.env.XAPPLY_SKIP_ENV_FILES !== '1') {
    const envFile = join(process.cwd(), 'apps/api/.env.local');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  loadEnvironment(process.env);
}

bootstrap();
