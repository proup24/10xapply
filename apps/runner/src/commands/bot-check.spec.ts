import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'patchright-core';
import type { Bridge } from '../bridge/bridge.js';
import type { RecorderBatch } from '../pace/recording.js';
import type { Pace } from '../pace/pace.js';
import type { Writer } from '../pace/writer.js';
import { testProfile } from '../pace/testing/profiles.js';
import {
  botCheckCommand,
  dabiPassword,
  type BotCheckDeps,
} from './bot-check.js';

const fx = (n: string) =>
  readFileSync(
    join(import.meta.dirname, '..', 'bot-check', 'fixtures', n),
    'utf8',
  );

const TEXT: Record<string, string> = {
  'https://bot-detector.rebrowser.net/': fx('rebrowser-clean.json'),
  'https://deviceandbrowserinfo.com/are_you_a_bot': fx('dabi-human.txt'),
  'https://www.browserscan.net/bot-detection': fx('browserscan-normal.txt'),
  'https://deviceandbrowserinfo.com/are_you_a_bot_interactions': fx(
    'dabi-interactions-clean.txt',
  ),
  'https://bot.incolumitas.com/': fx('incolumitas-human.txt'),
};

function setup(opts: { failUrl?: string; profile?: boolean } = {}) {
  const visited: string[] = [];
  const order: string[] = [];
  let url = '';
  const locator: Record<string, unknown> = {
    innerText: async () => TEXT[url],
    inputValue: async () => TEXT[url],
  };
  locator.first = () => locator;
  const page = {
    goto: vi.fn(async (u: string) => {
      if (u === opts.failUrl) throw new Error('boom');
      url = u;
      visited.push(u);
    }),
    locator: () => locator,
    getByLabel: () => locator,
    getByRole: () => locator,
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  let onBatch: (b: RecorderBatch) => void = () => undefined;
  const bridge = {
    openRunWindow: vi.fn(async () => {
      order.push('open');
      return page;
    }),
    stopReason: () => null,
    crashRunTab: vi.fn(),
    viewport: vi.fn(async () => ({ width: 1280, height: 800 })),
    startRecording: vi.fn(async () => void order.push('start')),
    stopRecording: vi.fn(async () => void order.push('stop')),
    onRecorderBatch: vi.fn((fn: (b: RecorderBatch) => void) => {
      onBatch = fn;
      return () => undefined;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as Bridge;
  const pace = {
    mood: 1,
    defaulted: [],
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    read: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
  } as unknown as Pace;
  const writer: Writer = {
    add: vi.fn(),
    counts: () => ({ pages: 0, clicks: 0, keyGaps: 0, wheels: 0 }),
    flush: vi.fn(() => {
      order.push('flush');
      return ['/pace/runner/test-page/S-none.json'];
    }),
  };
  let output = '';
  const createWriter = vi.fn(() => writer);
  const createPace = vi.fn(() => pace);
  const deps: BotCheckDeps = {
    cfg: { relayPort: 9444, token: 't' },
    connect: (async () => bridge) as never,
    loadProfile:
      opts.profile === false
        ? () => {
            throw new Error('no pace profile');
          }
        : () => testProfile(),
    createPace: createPace as never,
    createWriter,
    out: (t) => void (output += `${t}\n`),
    sleep: async () => undefined,
  };
  return {
    deps,
    bridge,
    visited,
    order,
    writer,
    createWriter,
    createPace,
    out: () => output,
    batch: (b: RecorderBatch) => onBatch(b),
  };
}

describe('dabiPassword', () => {
  it("always meets the login form's pattern and minlength", () => {
    for (let i = 0; i < 200; i++) {
      const pw = dabiPassword();
      expect(pw).toMatch(/^.*[>!?@#$&].*$/);
      expect(pw.length).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('botCheckCommand', () => {
  it('dabi-interactions types each field once (type clicks it) and clicks only Login', async () => {
    const s = setup();
    await botCheckCommand({ deps: s.deps });
    const pace = s.createPace.mock.results[0].value as Pace;
    const typed = vi.mocked(pace.type).mock.calls.map((c) => c[1]);
    expect(typed).toHaveLength(2);
    expect(typed[0]).toMatch(/^pace\.test\.\d+@example\.com$/);
    expect(typed[1]).toMatch(/[>!?@#$&]/);
    expect(vi.mocked(pace.click)).toHaveBeenCalledTimes(1);
  });

  it('repeat 3 runs the two behaviour pages three times and the first three once', async () => {
    const s = setup();
    const code = await botCheckCommand({ repeat: 3, deps: s.deps });
    const count = (u: string) => s.visited.filter((v) => v === u).length;
    expect(count('https://bot-detector.rebrowser.net/')).toBe(1);
    expect(count('https://deviceandbrowserinfo.com/are_you_a_bot')).toBe(1);
    expect(count('https://www.browserscan.net/bot-detection')).toBe(1);
    expect(
      count('https://deviceandbrowserinfo.com/are_you_a_bot_interactions'),
    ).toBe(3);
    expect(count('https://bot.incolumitas.com/')).toBe(3);
    expect(s.createPace).toHaveBeenCalledTimes(6);
    expect(s.out()).toContain('dabi-interactions #3');
    expect(s.out()).toContain('incolumitas #1');
    expect(code).toBe(0);
  });

  it('defaults to one run and no recording', async () => {
    const s = setup();
    await botCheckCommand({ deps: s.deps });
    expect(s.visited).toHaveLength(5);
    expect(s.createWriter).not.toHaveBeenCalled();
    expect(s.bridge.startRecording).not.toHaveBeenCalled();
    expect(s.out()).toMatch(/incolumitas\s+PASS/);
  });

  it('--record starts recording with source test-page and flushes to runner/', async () => {
    const s = setup();
    await botCheckCommand({ record: true, deps: s.deps });
    expect(s.createWriter).toHaveBeenCalledOnce();
    expect(s.order.indexOf('start')).toBeLessThan(s.order.indexOf('open'));
    expect(s.order.indexOf('stop')).toBeLessThan(s.order.indexOf('flush'));
    expect(s.out()).toContain('/pace/runner/test-page/S-none.json');
    const batch = { pageId: 'p', events: [] } as unknown as RecorderBatch;
    s.batch(batch);
    expect(s.writer.add).toHaveBeenCalledWith(batch);
  });

  it('writes recordings as the runner, filed as test-page', async () => {
    // The real writer files a non-practice, non-typing, non-jobs path as test-page.
    const { createWriter } = await import('../pace/writer.js');
    const { mkdtempSync, readFileSync: read } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'bc-'));
    const w = createWriter({ dir, actor: 'runner', sittingId: 'S' });
    w.add({
      pageId: 'p',
      page: {
        id: 'p',
        ctx: { path: '/are_you_a_bot', dialog: false, progress: null },
      },
      events: [],
    } as unknown as RecorderBatch);
    const [path] = w.flush();
    expect(path).toContain(join(dir, 'runner', 'test-page'));
    expect(JSON.parse(read(path, 'utf8'))).toMatchObject({
      actor: 'runner',
      source: 'test-page',
    });
  });

  it('a page that fails to load is reported as not run', async () => {
    const s = setup({ failUrl: 'https://www.browserscan.net/bot-detection' });
    const code = await botCheckCommand({ deps: s.deps });
    expect(s.out()).toMatch(/browserscan\s+NOT RUN\s+load or read failed/);
    expect(s.out()).toMatch(/rebrowser\s+PASS/);
    expect(code).toBe(2);
  });

  it('without a profile the behaviour pages are not run and the rest still run', async () => {
    const s = setup({ profile: false });
    const code = await botCheckCommand({ deps: s.deps });
    expect(s.visited).toHaveLength(3);
    expect(s.out()).toMatch(/dabi-interactions\s+NOT RUN\s+no pace profile/);
    expect(s.out()).toMatch(/incolumitas\s+NOT RUN\s+no pace profile/);
    expect(s.out()).toMatch(/rebrowser\s+PASS/);
    expect(code).toBe(2);
  });

  it('hands pace the bridge viewport and drives the form with the mouse', async () => {
    const s = setup();
    await botCheckCommand({ deps: s.deps });
    const [, , pdeps] = s.createPace.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { viewport: () => Promise<unknown> },
    ];
    expect(await pdeps.viewport()).toEqual({ width: 1280, height: 800 });
  });
});
