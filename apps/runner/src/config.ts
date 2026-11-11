import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Absolute path of apps/runner/.env.local. */
export const ENV_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.env.local',
);

export interface RunnerConfig {
  relayPort: number;
  token: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_RELAY_PORT = 9333;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = ENV_FILE,
): RunnerConfig {
  // Like process.loadEnvFile, but into a copy: variables already set win.
  const file = existsSync(envFile)
    ? parseEnv(readFileSync(envFile, 'utf8'))
    : {};
  const merged = { ...file, ...env };
  const token = merged.RUNNER_BRIDGE_TOKEN;
  if (!token) {
    throw new ConfigError(
      'no bridge token: run `pnpm nx run runner:bridge-install` first',
    );
  }
  const raw = merged.RUNNER_RELAY_PORT;
  const relayPort = raw ? Number(raw) : DEFAULT_RELAY_PORT;
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new ConfigError(`invalid RUNNER_RELAY_PORT: ${raw}`);
  }
  return { relayPort, token };
}
