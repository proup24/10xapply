import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'patchright-core';
import { connectBridge } from '../bridge/bridge.js';
import {
  formatTable,
  parseBrowserscan,
  parseDabi,
  parseDabiInteractions,
  parseRebrowser,
  type CheckResult,
} from '../bot-check/parse.js';
import { loadConfig } from '../config.js';

interface Target {
  name: string;
  url: string;
  waitMs: number;
  /** Runs after load and before `read`. */
  act?: (page: Page) => Promise<void>;
  read: (page: Page) => Promise<string>;
  parse: (text: string) => CheckResult;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const randomText = (n: number): string =>
  Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    '',
  );

// Temporary: drives the form with raw page.mouse/page.keyboard. A later task
// replaces it with the pace module.
async function clickAt(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error('no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 25,
  });
  await page.mouse.down();
  await page.mouse.up();
}

async function fillLoginForm(page: Page): Promise<void> {
  await clickAt(page, '#email');
  await page.keyboard.type(`pace.test.${randomInt(100000, 1000000)}@example.com`, {
    delay: 120,
  });
  await clickAt(page, '#password');
  // The page requires one special character.
  await page.keyboard.type(`${randomText(11)}!`, { delay: 120 });
  await clickAt(page, '#loginForm button[type="submit"]');
  await sleep(5_000);
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
    name: 'dabi-interactions',
    url: 'https://deviceandbrowserinfo.com/are_you_a_bot_interactions',
    waitMs: 3_000,
    act: fillLoginForm,
    read: (p) => p.locator('body').innerText(),
    parse: parseDabiInteractions,
  },
  {
    name: 'browserscan',
    url: 'https://www.browserscan.net/bot-detection',
    waitMs: 9_000,
    read: (p) => p.locator('body').innerText(),
    parse: parseBrowserscan,
  },
];

export async function botCheckCommand(): Promise<number> {
  const cfg = loadConfig();
  const bridge = await connectBridge(cfg);
  if ('unavailable' in bridge) {
    console.log(bridge.unavailable);
    return 2;
  }
  const results: CheckResult[] = [];
  let page: Page | undefined;
  try {
    page = await bridge.openRunWindow();
    for (const t of TARGETS) {
      if (bridge.stopReason()) {
        results.push({ page: t.name, passed: false, detail: ['not run'] });
        continue;
      }
      try {
        await page.goto(t.url, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await sleep(t.waitMs);
        await t.act?.(page);
        results.push(t.parse(await t.read(page)));
      } catch {
        // Short reason only, never the page's text.
        results.push({
          page: t.name,
          passed: false,
          detail: [bridge.stopReason() ? 'stopped' : 'load or read failed'],
        });
      }
    }
  } catch {
    for (const t of TARGETS.slice(results.length)) {
      results.push({ page: t.name, passed: false, detail: ['not run'] });
    }
  } finally {
    try {
      await page?.close();
    } catch {
      // ignore
    }
    await bridge.close();
  }
  console.log(formatTable(results));
  return results.length === TARGETS.length && results.every((r) => r.passed)
    ? 0
    : 2;
}
