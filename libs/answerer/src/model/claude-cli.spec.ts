import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ModelCallError, ModelUnavailableError } from './caller.js';
import {
  childEnv,
  claudeArgs,
  createClaudeCliCaller,
  type Spawn,
} from './claude-cli.js';

const SECRET = 'SECRET-PROMPT-TEXT-xyz';
const schema = z.object({ n: z.number() });
const req = {
  role: 'answer' as const,
  model: 'opus',
  system: 'sys',
  prompt: SECRET,
  schema,
};
type Out = { code: number | null; stdout: string; timedOut: boolean };
const ok = (obj: unknown): Out => ({
  code: 0,
  stdout: JSON.stringify(obj),
  timedOut: false,
});
const good = ok({
  is_error: false,
  structured_output: { n: 7 },
  total_cost_usd: 0.01,
});

const noSleep = async () => undefined;

function scripted(outs: Out[]) {
  const calls: Array<Parameters<Spawn>> = [];
  const spawn: Spawn = async (...a) => {
    calls.push(a);
    const o = outs[calls.length - 1];
    if (!o) throw new Error('no more');
    return o;
  };
  return { spawn, calls };
}

describe('claudeArgs / childEnv', () => {
  it('builds the locked-down argument list', () => {
    expect(claudeArgs({ model: 'opus', system: 'S', jsonSchema: {} })).toEqual([
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      '{}',
      '--system-prompt',
      'S',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--model',
      'opus',
    ]);
  });
  it('removes the API credentials and provider overrides, nothing else', () => {
    expect(
      childEnv({
        ANTHROPIC_API_KEY: 'k',
        ANTHROPIC_AUTH_TOKEN: 't',
        ANTHROPIC_BASE_URL: 'https://proxy.invalid',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_USE_FOUNDRY: '1',
        AWS_BEARER_TOKEN_BEDROCK: 'b',
        CLAUDE_CONFIG_DIR: '/home/x/.claude',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        PATH: '/bin',
      }),
    ).toEqual({
      CLAUDE_CONFIG_DIR: '/home/x/.claude',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      PATH: '/bin',
      DISABLE_AUTOUPDATER: '1',
    });
  });
});

describe('createClaudeCliCaller', () => {
  it('parses structured_output, takes cost, runs in a fresh temp dir with prompt on stdin', async () => {
    const { spawn, calls } = scripted([good]);
    const caller = createClaudeCliCaller({
      spawn,
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k' },
    });
    const res = await caller.call(req);
    expect(res.value).toEqual({ n: 7 });
    expect(res.stat).toMatchObject({
      role: 'answer',
      model: 'opus',
      costUsd: 0.01,
      ok: true,
    });
    const [args, opts] = calls[0];
    const schemaArg = args[args.indexOf('--json-schema') + 1];
    expect(JSON.parse(schemaArg)).toMatchObject({ type: 'object' });
    expect(schemaArg).not.toContain('$schema');
    expect(opts.stdin).toBe(SECRET);
    expect(opts.cwd).not.toBe(process.cwd());
    expect(opts.cwd.startsWith(tmpdir())).toBe(true);
    expect(opts.env).toEqual({ PATH: '/bin', DISABLE_AUTOUPDATER: '1' });
    expect(opts.timeoutMs).toBe(180_000);
    expect(existsSync(opts.cwd)).toBe(false);
  });

  it('costUsd is null when total_cost_usd is missing', async () => {
    const { spawn } = scripted([ok({ structured_output: { n: 1 } })]);
    const res = await createClaudeCliCaller({ sleep: noSleep, spawn }).call(req);
    expect(res.stat.costUsd).toBeNull();
  });

  it('retries after non-JSON stdout such as an update banner', async () => {
    const { spawn, calls } = scripted([
      { code: 0, stdout: 'Update available!\n', timedOut: false },
      good,
    ]);
    const res = await createClaudeCliCaller({ sleep: noSleep, spawn }).call(req);
    expect(res.value).toEqual({ n: 7 });
    expect(calls).toHaveLength(2);
  });

  it('throws ModelCallError after three transient failures', async () => {
    const bad: Out[] = [
      { code: 1, stdout: '', timedOut: false },
      { code: null, stdout: '', timedOut: true },
      ok({ is_error: true, result: `echo ${SECRET}` }),
    ];
    const { spawn, calls } = scripted(bad);
    const err = await createClaudeCliCaller({ sleep: noSleep, spawn })
      .call(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(calls).toHaveLength(3);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it.each([
    ['missing structured_output', ok({ is_error: false })],
    ['zod failure', ok({ structured_output: { n: 'x' } })],
  ])('treats %s as transient', async (_n, out) => {
    const { spawn, calls } = scripted([out, out, out]);
    await expect(
      createClaudeCliCaller({ sleep: noSleep, spawn }).call(req),
    ).rejects.toBeInstanceOf(ModelCallError);
    expect(calls).toHaveLength(3);
  });

  it('honours the retries option', async () => {
    const bad = { code: 1, stdout: '', timedOut: false };
    const { spawn, calls } = scripted([bad, bad]);
    await expect(
      createClaudeCliCaller({ sleep: noSleep, spawn, retries: 1 }).call(req),
    ).rejects.toBeInstanceOf(ModelCallError);
    expect(calls).toHaveLength(2);
  });

  it('api_error_status 401 is unavailable, no retry', async () => {
    const { spawn, calls } = scripted([
      ok({ is_error: true, api_error_status: 401 }),
    ]);
    await expect(
      createClaudeCliCaller({ sleep: noSleep, spawn }).call(req),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it('usage limit result is unavailable', async () => {
    const { spawn, calls } = scripted([
      ok({ is_error: true, result: 'Claude usage limit reached' }),
    ]);
    const err = await createClaudeCliCaller({ sleep: noSleep, spawn })
      .call(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as Error).message).not.toContain('usage limit');
    expect(calls).toHaveLength(1);
  });

  it('unparsable stdout that looks like a login prompt is unavailable', async () => {
    const { spawn } = scripted([
      { code: 1, stdout: 'Please log in', timedOut: false },
    ]);
    await expect(
      createClaudeCliCaller({ sleep: noSleep, spawn }).call(req),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('a successful answer mentioning authentication and log in returns normally', async () => {
    const s = z.object({ text: z.string() });
    const { spawn } = scripted([
      ok({
        is_error: false,
        structured_output: { text: 'I built authentication and log in flows' },
        result: 'authentication log in',
      }),
    ]);
    const res = await createClaudeCliCaller({ sleep: noSleep, spawn }).call({
      ...req,
      schema: s,
    });
    expect(res.value.text).toContain('authentication');
  });

  it('error messages never contain the prompt or zod detail', async () => {
    const { spawn } = scripted([
      ok({ structured_output: { n: SECRET } }),
      ok({ structured_output: { n: SECRET } }),
      ok({ structured_output: { n: SECRET } }),
    ]);
    const err = (await createClaudeCliCaller({ sleep: noSleep, spawn })
      .call(req)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toMatch(/^claude -p failed: [a-z ]+$/);
  });

  it('removes the temp dir when spawn throws', async () => {
    let dir = '';
    const spawn: Spawn = async (_a, o) => {
      dir = o.cwd;
      throw new Error('boom');
    };
    await expect(
      createClaudeCliCaller({ sleep: noSleep, spawn, retries: 0 }).call(req),
    ).rejects.toBeInstanceOf(ModelCallError);
    expect(existsSync(dir)).toBe(false);
  });

  describe('waits between attempts', () => {
    const recorder = () => {
      const waits: number[] = [];
      return { waits, sleep: async (ms: number) => void waits.push(ms) };
    };
    const bad: Out = { code: 1, stdout: '', timedOut: false };

    it('waits 5 s, then 30 s, and not after the last attempt', async () => {
      const { spawn } = scripted([bad, bad, bad]);
      const { waits, sleep } = recorder();
      await expect(
        createClaudeCliCaller({ spawn, sleep }).call(req),
      ).rejects.toBeInstanceOf(ModelCallError);
      expect(waits).toEqual([5_000, 30_000]);
    });

    it('does not wait when the first attempt succeeds', async () => {
      const { spawn } = scripted([good]);
      const { waits, sleep } = recorder();
      await createClaudeCliCaller({ spawn, sleep }).call(req);
      expect(waits).toEqual([]);
    });

    it('rides out a CLI that cannot start for a moment, such as during its own update', async () => {
      let n = 0;
      const spawn: Spawn = async () => {
        n++;
        if (n === 1) throw new Error('spawn ENOENT');
        return n === 2 ? bad : good;
      };
      const { waits, sleep } = recorder();
      const res = await createClaudeCliCaller({ spawn, sleep }).call(req);
      expect(res.value).toEqual({ n: 7 });
      expect(waits).toEqual([5_000, 30_000]);
    });

    it('honours retryDelaysMs, reusing the last delay', async () => {
      const { spawn } = scripted([bad, bad, bad, bad]);
      const { waits, sleep } = recorder();
      await expect(
        createClaudeCliCaller({
          spawn,
          sleep,
          retries: 3,
          retryDelaysMs: [1, 2],
        }).call(req),
      ).rejects.toBeInstanceOf(ModelCallError);
      expect(waits).toEqual([1, 2, 2]);
    });

    it('does not wait or retry when the model is unavailable', async () => {
      const { spawn } = scripted([ok({ is_error: true, api_error_status: 401 })]);
      const { waits, sleep } = recorder();
      await expect(
        createClaudeCliCaller({ spawn, sleep }).call(req),
      ).rejects.toBeInstanceOf(ModelUnavailableError);
      expect(waits).toEqual([]);
    });
  });
});
