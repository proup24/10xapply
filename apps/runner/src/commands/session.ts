import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'patchright-core';
import { UNAVAILABLE_MESSAGE, connectBridge } from '../bridge/bridge.js';
import { loadConfig } from '../config.js';
import { writeRunReport, type SessionReport } from '../reports/write-report.js';
import { runSession, type SessionPage } from '../session/session.js';

/** Adapts a Patchright page. Reads only the URL and locator counts. */
function adapt(page: Page): SessionPage {
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    },
    path: () => new URL(page.url()).pathname,
    count: (selector) => page.locator(selector).count(),
    close: () => page.close(),
  };
}

export async function sessionCommand(): Promise<number> {
  const cfg = loadConfig();
  const bridge = await connectBridge(cfg);
  let report: SessionReport;
  if ('unavailable' in bridge) {
    console.log(bridge.unavailable);
    report = {
      kind: 'session',
      startedAt: new Date().toISOString(),
      result: 'bridge-unavailable',
      pathPrefix: null,
      stopReason: UNAVAILABLE_MESSAGE,
      timings: { loadMs: 0, totalMs: 0 },
    };
  } else {
    try {
      report = await runSession({
        openPage: async () => adapt(await bridge.openRunWindow()),
        stopReason: () => bridge.stopReason(),
        wait: (ms) => sleep(ms),
        randomInt: (min, max) => randomInt(min, max),
        now: () => Date.now(),
      });
    } finally {
      await bridge.close();
    }
  }
  const file = writeRunReport(report);
  console.log(`session: ${report.result}`);
  console.log(`report: ${file}`);
  return report.result === 'signed-in' ? 0 : 2;
}
