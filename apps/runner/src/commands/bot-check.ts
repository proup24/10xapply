import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'patchright-core';
import { connectBridge } from '../bridge/bridge.js';
import {
  formatTable,
  parseBrowserscan,
  parseDabi,
  parseRebrowser,
  type CheckResult,
} from '../bot-check/parse.js';
import { loadConfig } from '../config.js';

interface Target {
  name: string;
  url: string;
  waitMs: number;
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
