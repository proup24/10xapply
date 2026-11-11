import { randomBytes, randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'patchright-core';
import { connectBridge, type Bridge } from '../bridge/bridge.js';
import {
  formatTable,
  parseBrowserscan,
  parseDabi,
  parseDabiInteractions,
  parseIncolumitas,
  parseRebrowser,
  type CheckResult,
} from '../bot-check/parse.js';
import { loadConfig, type RunnerConfig } from '../config.js';
import { createPace, type Pace } from '../pace/pace.js';
import { PACE_DIR } from '../pace/paths.js';
import { loadProfile, type PaceProfile } from '../pace/profile.js';
import { createWriter, type Writer } from '../pace/writer.js';
import { sittingIdNow } from './pace.js';

interface Target {
  name: string;
  url: string;
  waitMs: number;
  /** Behaviour pages are driven by the pace module and repeat with `--repeat`. */
  behaviour?: boolean;
  /** Runs after load and before `read`; only behaviour pages have one. */
  act?: (
    page: Page,
    pace: Pace,
    wait: (ms: number) => Promise<void>,
  ) => Promise<void>;
  read: (page: Page) => Promise<string>;
  parse: (text: string) => CheckResult;
}

const TARGETS: Target[] = [
  {
    name: 'rebrowser',
    url: 'https://bot-detector.rebrowser.net/',
    waitMs: 4_000,
    read: (p) => p.locator('#detections-json').inputValue(),
    parse: parseRebrowser,
  },
  {
    name: 'deviceandbrowserinfo',
    url: 'https://deviceandbrowserinfo.com/are_you_a_bot',
    waitMs: 7_000,
    read: (p) => p.locator('body').innerText(),
    parse: parseDabi,
  },
  {
    name: 'browserscan',
    url: 'https://www.browserscan.net/bot-detection',
    waitMs: 9_000,
    read: (p) => p.locator('body').innerText(),
    parse: parseBrowserscan,
  },
  {
    name: 'dabi-interactions',
    url: 'https://deviceandbrowserinfo.com/are_you_a_bot_interactions',
    waitMs: 3_000,
    behaviour: true,
    // Fills the page's own login form with made-up values, mouse only.
    // `pace.type` clicks each field itself. The password field has
    // pattern=".*[>!?@#$&].*" and minlength 8: without one of those
    // characters the browser blocks the submit and no verdict appears.
    act: async (p, pace, wait) => {
      await pace.type(
        p.getByLabel('Email address'),
        `pace.test.${randomInt(100_000, 1_000_000)}@example.com`,
      );
      await pace.type(
        p.getByLabel('Password', { exact: true }),
        dabiPassword(),
      );
      await pace.pause();
      await pace.click(p.getByRole('button', { name: 'Login', exact: true }));
      await wait(DABI_RESULT_MS);
    },
    read: (p) => p.locator('body').innerText(),
    parse: parseDabiInteractions,
  },
  {
    // The behavioural score is computed from mouse, scroll and key activity:
    // first after 1.5 s, then updated at 4, 7, 10 and 15 s. So the pace module
    // moves and scrolls for a while, and the page is read after 15 s.
    name: 'incolumitas',
    url: 'https://bot.incolumitas.com/',
    waitMs: 2_000,
    behaviour: true,
    act: async (p, pace, wait) => {
      const body = p.locator('body');
      await pace.read(null);
      await pace.scroll(body, 3);
      await pace.pause();
      await pace.scroll(body, 2);
      await pace.read(null);
      await pace.scroll(body, -4);
      await pace.pause();
      await wait(INCOLUMITAS_SETTLE_MS);
    },
    read: (p) => p.locator('body').innerText(),
    parse: parseIncolumitas,
  },
];

/** A made-up password the dabi login form accepts (a special character, ≥ 8). */
export function dabiPassword(): string {
  const special = DABI_SPECIAL[randomInt(DABI_SPECIAL.length)];
  return randomBytes(9).toString('base64url') + special;
}
const DABI_SPECIAL = '!?@#$';

/** After Login, the page needs a moment to show its verdict. */
const DABI_RESULT_MS = 5_000;

/** Keeps the page open until its last (15 s) score update has arrived. */
const INCOLUMITAS_SETTLE_MS = 8_000;

const notRun = (name: string, why: string): CheckResult => ({
  page: name,
  passed: false,
  notRun: true,
  detail: [why],
});

export interface BotCheckDeps {
  cfg?: RunnerConfig;
  connect?: typeof connectBridge;
  loadProfile?: () => PaceProfile;
  createPace?: typeof createPace;
  createWriter?: (sittingId: string) => Writer;
  out?: (text: string) => void;
  /** Waits; tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

/** The label of one result row: a repeated page gets its run number. */
const label = (name: string, run: number, repeat: number) =>
  repeat > 1 ? `${name} #${run}` : name;

/** The two behaviour pages repeat `repeat` times; the first three run once. */
export async function botCheckCommand(
  opts: { repeat?: number; record?: boolean; deps?: BotCheckDeps } = {},
): Promise<number> {
  const deps = opts.deps ?? {};
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const out = deps.out ?? ((t: string) => void console.log(t));
  const cfg = deps.cfg ?? loadConfig();
  const bridge: Bridge | { unavailable: string } = await (
    deps.connect ?? connectBridge
  )(cfg);
  if ('unavailable' in bridge) {
    out(bridge.unavailable);
    return 2;
  }

  // The profile is needed only for the behaviour pages.
  let profile: PaceProfile | null = null;
  try {
    profile = (deps.loadProfile ?? (() => loadProfile()))();
  } catch {
    profile = null;
  }

  const plan: { target: Target; label: string }[] = [
    ...TARGETS.filter((t) => !t.behaviour).map((t) => ({
      target: t,
      label: t.name,
    })),
  ];
  for (let run = 1; run <= repeat; run++) {
    for (const t of TARGETS.filter((x) => x.behaviour)) {
      plan.push({ target: t, label: label(t.name, run, repeat) });
    }
  }

  const sittingId = sittingIdNow();
  const writer = opts.record
    ? (deps.createWriter?.(sittingId) ??
      createWriter({ dir: PACE_DIR, actor: 'runner', sittingId }))
    : null;
  const makePace = deps.createPace ?? createPace;
  const wait = deps.sleep ?? ((ms: number) => sleep(ms));

  const results: CheckResult[] = [];
  let page: Page | undefined;
  let offBatches: (() => void) | undefined;
  try {
    if (writer) {
      offBatches = bridge.onRecorderBatch((b) => writer.add(b));
      await bridge.startRecording(randomBytes(16).toString('hex'));
    }
    page = await bridge.openRunWindow();
    for (const { target: t, label: name } of plan) {
      if (bridge.stopReason()) {
        results.push(notRun(name, 'not run'));
        continue;
      }
      if (t.behaviour && !profile) {
        results.push(notRun(name, 'no pace profile'));
        continue;
      }
      try {
        await page.goto(t.url, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await wait(t.waitMs);
        if (t.behaviour && t.act && profile) {
          await t.act(
            page,
            makePace(page, profile, { viewport: () => bridge.viewport() }),
            wait,
          );
        }
        results.push({ ...t.parse(await t.read(page)), page: name });
      } catch {
        // Short reason only, never the page's text.
        results.push(
          notRun(name, bridge.stopReason() ? 'stopped' : 'load or read failed'),
        );
      }
    }
  } catch {
    for (const p of plan.slice(results.length)) {
      results.push(notRun(p.label, 'not run'));
    }
  } finally {
    offBatches?.();
    if (writer) {
      await bridge.stopRecording().catch(() => undefined);
    }
    try {
      await page?.close();
    } catch {
      // ignore
    }
    await bridge.close();
  }
  out(formatTable(results));
  if (writer) {
    try {
      const paths = writer.flush();
      out(paths.length ? paths.join('\n') : 'no recordings written');
    } catch {
      out('recordings could not be written');
    }
  }
  return results.length === plan.length && results.every((r) => r.passed)
    ? 0
    : 2;
}
