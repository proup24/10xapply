import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ModelCallError,
  ModelUnavailableError,
  type ModelCaller,
  type ModelRequest,
  type ModelResponse,
} from './caller.js';

export type Spawn = (
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
    timeoutMs: number;
  },
) => Promise<{ code: number | null; stdout: string; timedOut: boolean }>;

const UNAVAILABLE =
  /usage limit|rate limit|log ?in|not logged|authenticat|subscription/i;

export function claudeArgs(req: {
  model: string;
  system: string;
  jsonSchema: object;
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.jsonSchema),
    '--system-prompt',
    req.system,
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--model',
    req.model,
  ];
}

/**
 * Variables that would move `claude` off the signed-in subscription: API
 * credentials, another endpoint, or another provider. Other `CLAUDE_*`
 * variables stay, because the subscription sign-in may depend on them.
 */
const SCRUBBED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const;

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  for (const name of SCRUBBED_ENV) delete rest[name];
  return rest;
}

/** Default spawn: stdout is collected, stderr is discarded, the child is killed on timeout. */
export function makeNodeSpawn(binary: string): Spawn {
  return (args, opts) =>
    new Promise((resolve, reject) => {
      const child = nodeSpawn(binary, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        stdout += d;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, timedOut });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.stdin);
    });
}

type Attempt<T> =
  | { kind: 'ok'; value: T; costUsd: number | null }
  | { kind: 'transient'; reason: string };

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createClaudeCliCaller(
  opts: {
    spawn?: Spawn;
    env?: NodeJS.ProcessEnv;
    retries?: number;
    timeoutMs?: number;
    binary?: string;
  } = {},
): ModelCaller {
  const spawn = opts.spawn ?? makeNodeSpawn(opts.binary ?? 'claude');
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const env = childEnv(opts.env ?? process.env);

  async function attempt<T>(req: ModelRequest<T>): Promise<Attempt<T>> {
    const cwd = await mkdtemp(join(tmpdir(), 'xapply-claude-'));
    try {
      // The CLI's validator rejects the draft 2020-12 `$schema` URI zod emits.
      const jsonSchema: Record<string, unknown> = {
        ...z.toJSONSchema(req.schema),
      };
      delete jsonSchema.$schema;
      const out = await spawn(
        claudeArgs({ model: req.model, system: req.system, jsonSchema }),
        { cwd, env, stdin: req.prompt, timeoutMs },
      );
      if (out.timedOut) return { kind: 'transient', reason: 'timeout' };
      const json = parseJson(out.stdout);
      const status = json?.api_error_status;
      if (status === 401 || status === 403) throw unavailable();
      const failed = out.code !== 0 || json === null || json.is_error === true;
      if (failed) {
        const text =
          json === null
            ? out.stdout
            : typeof json.result === 'string'
              ? json.result
              : '';
        if (UNAVAILABLE.test(text)) throw unavailable();
        return {
          kind: 'transient',
          reason:
            out.code !== 0
              ? 'non-zero exit'
              : json
                ? 'error result'
                : 'invalid output',
        };
      }
      if (
        json.structured_output === undefined ||
        json.structured_output === null
      )
        return { kind: 'transient', reason: 'missing output' };
      const parsed = req.schema.safeParse(json.structured_output);
      if (!parsed.success)
        return { kind: 'transient', reason: 'invalid output' };
      const cost = json.total_cost_usd;
      return {
        kind: 'ok',
        value: parsed.data,
        costUsd: typeof cost === 'number' ? cost : null,
      };
    } catch (e) {
      if (e instanceof ModelUnavailableError) throw e;
      return { kind: 'transient', reason: 'spawn error' };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  return {
    async call<T>(req: ModelRequest<T>): Promise<ModelResponse<T>> {
      const started = Date.now();
      let reason = 'unknown';
      for (let i = 0; i <= retries; i++) {
        const r = await attempt(req);
        if (r.kind === 'ok') {
          return {
            value: r.value,
            stat: {
              role: req.role,
              model: req.model,
              latencyMs: Date.now() - started,
              costUsd: r.costUsd,
              ok: true,
            },
          };
        }
        reason = r.reason;
      }
      throw new ModelCallError(`claude -p failed: ${reason}`);
    },
  };
}

function unavailable(): ModelUnavailableError {
  return new ModelUnavailableError(
    'claude -p unavailable: sign-in or plan limit',
  );
}
