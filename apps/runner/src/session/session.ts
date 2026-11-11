import { pathPrefix, type SessionReport } from '../reports/write-report.js';
import {
  CHALLENGE,
  SIGN_IN_FORM,
  classifySession,
  type SessionResult,
} from './classify.js';

export const FEED_URL = 'https://www.linkedin.com/feed/';

export interface SessionPage {
  /** domcontentloaded, 30 s timeout. */
  goto(url: string): Promise<void>;
  path(): string;
  count(selector: string): Promise<number>;
  close(): Promise<void>;
}

export interface SessionDeps {
  openPage(): Promise<SessionPage>;
  stopReason(): string | null;
  wait(ms: number): Promise<void>;
  /** crypto.randomInt in production: max is exclusive. */
  randomInt(min: number, max: number): number;
  now(): number;
}

/** One load of the feed, then a pure-code classification. No retry, no reload. */
export async function runSession(d: SessionDeps): Promise<SessionReport> {
  const t0 = d.now();
  const startedAt = new Date(t0).toISOString();
  let result: SessionResult = 'unexpected-page';
  let prefix: string | null = null;
  let stopReason: string | undefined;
  let loadMs = 0;

  const stopped = (): boolean => {
    const r = d.stopReason();
    if (r === null) return false;
    result = 'stopped';
    stopReason = r;
    return true;
  };

  let page: SessionPage;
  try {
    page = await d.openPage();
  } catch {
    // No page was opened, so there is nothing to close.
    if (!stopped()) result = 'unexpected-page';
    return finish();
  }
  try {
    try {
      await page.goto(FEED_URL);
      loadMs = d.now() - t0;
      await d.wait(d.randomInt(4000, 8000));
    } catch {
      loadMs = d.now() - t0;
      if (!stopped()) result = 'unexpected-page';
      return finish();
    }
    if (stopped()) return finish();
    try {
      const path = page.path();
      prefix = pathPrefix(path);
      const [signInForms, challenges] = await Promise.all([
        page.count(SIGN_IN_FORM),
        page.count(CHALLENGE),
      ]);
      result = classifySession({ path, signInForms, challenges });
      await d.wait(d.randomInt(1500, 4000));
    } catch {
      if (!stopped()) result = 'unexpected-page';
    }
    return finish();
  } finally {
    try {
      await page.close();
    } catch {
      // Closing must never fail the session.
    }
  }

  function finish(): SessionReport {
    const report: SessionReport = {
      kind: 'session',
      startedAt,
      result,
      pathPrefix: prefix,
      timings: { loadMs, totalMs: d.now() - t0 },
    };
    if (stopReason !== undefined) report.stopReason = stopReason;
    return report;
  }
}
