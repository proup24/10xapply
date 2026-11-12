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

function mergedEnv(env: NodeJS.ProcessEnv, envFile: string) {
  // Like process.loadEnvFile, but into a copy: variables already set win.
  const file = existsSync(envFile)
    ? parseEnv(readFileSync(envFile, 'utf8'))
    : {};
  return { ...file, ...env };
}

function portFrom(merged: NodeJS.ProcessEnv): number {
  const raw = merged.RUNNER_RELAY_PORT;
  const port = raw ? Number(raw) : DEFAULT_RELAY_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`invalid RUNNER_RELAY_PORT: ${raw}`);
  }
  return port;
}

/** The relay port, resolved exactly as loadConfig does. */
export function resolveRelayPort(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = ENV_FILE,
): number {
  return portFrom(mergedEnv(env, envFile));
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = ENV_FILE,
): RunnerConfig {
  const merged = mergedEnv(env, envFile);
  const token = merged.RUNNER_BRIDGE_TOKEN;
  if (!token) {
    throw new ConfigError(
      'no bridge token: run `pnpm nx run runner:bridge-install` first',
    );
  }
  return { relayPort: portFrom(merged), token };
}

export interface AnswerConfig {
  answerModel: string;
  verifyModel: string;
  judgeModel: string;
  maxRegenerations: number;
}

export const DEFAULT_ANSWER_MODEL = 'opus';
export const MAX_REGENERATIONS_LIMIT = 3;

/** The answerer's models and regeneration limit, from the env and the env file. */
export function loadAnswerConfig(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = ENV_FILE,
): AnswerConfig {
  const merged = mergedEnv(env, envFile);
  const raw = merged.ANSWER_MAX_REGENERATIONS;
  const maxRegenerations = raw ? Number(raw) : 1;
  if (
    !Number.isInteger(maxRegenerations) ||
    maxRegenerations < 0 ||
    maxRegenerations > MAX_REGENERATIONS_LIMIT
  ) {
    throw new ConfigError(
      `invalid ANSWER_MAX_REGENERATIONS: needs a whole number from 0 to ${MAX_REGENERATIONS_LIMIT}`,
    );
  }
  return {
    answerModel: merged.ANSWER_MODEL || DEFAULT_ANSWER_MODEL,
    verifyModel: merged.ANSWER_VERIFY_MODEL || DEFAULT_ANSWER_MODEL,
    judgeModel: merged.ANSWER_JUDGE_MODEL || DEFAULT_ANSWER_MODEL,
    maxRegenerations,
  };
}
