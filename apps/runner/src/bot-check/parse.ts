export interface CheckResult {
  page: string;
  passed: boolean;
  detail: string[];
  /** The page was not checked (not loadable, stopped, or no profile); shown apart from FAIL. */
  notRun?: boolean;
}

const unparseable = (page: string): CheckResult => ({
  page,
  passed: false,
  detail: ['unparseable'],
});

export function parseRebrowser(json: string): CheckResult {
  const page = 'rebrowser';
  try {
    const data: unknown = JSON.parse(json);
    // An empty list, or an entry without a numeric rating, proves nothing.
    if (!Array.isArray(data) || data.length === 0) return unparseable(page);
    const failed: string[] = [];
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) {
        return unparseable(page);
      }
      const { type, rating } = entry as { type?: unknown; rating?: unknown };
      if (typeof rating !== 'number') return unparseable(page);
      if (rating === 1) failed.push(typeof type === 'string' ? type : '?');
    }
    return { page, passed: failed.length === 0, detail: failed };
  } catch {
    return unparseable(page);
  }
}

export function parseDabi(text: string): CheckResult {
  const page = 'deviceandbrowserinfo';
  const text_ = typeof text === 'string' ? text : '';
  if (!/"isBot"\s*:\s*(true|false)/.test(text_)) return unparseable(page);
  const passed = /"isBot"\s*:\s*false/.test(text_);
  const detail = [...text_.matchAll(/"(\w+)"\s*:\s*true\b/g)].map((m) => m[1]);
  return { page, passed, detail };
}

export function parseDabiInteractions(text: string): CheckResult {
  const page = 'dabi-interactions';
  const text_ = typeof text === 'string' ? text : '';
  const flag = (name: string) =>
    new RegExp(`"${name}"\\s*:\\s*(true|false)`).exec(text_)?.[1];
  const flags = [
    'isBot',
    'suspiciousClientSideBehavior',
    'superHumanSpeed',
    'hasCDPMouseLeak',
  ].map((n) => flag(n));
  if (flags.some((f) => f === undefined)) return unparseable(page);
  const detail = [...text_.matchAll(/"(\w+)"\s*:\s*true\b/g)].map((m) => m[1]);
  return { page, passed: flags.every((f) => f === 'false'), detail };
}

export function parseBrowserscan(text: string): CheckResult {
  const page = 'browserscan';
  const lines = (typeof text === 'string' ? text : '').split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes('Test Results:'));
  if (i < 0) return unparseable(page);
  const next = lines
    .slice(i + 1)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (next === undefined) return unparseable(page);
  return {
    page,
    passed: next === 'Normal',
    detail: next === 'Normal' ? [] : [next],
  };
}

/**
 * bot.incolumitas.com, "Behavioral Bot Classification": the page shows
 * "Your Behavioral Score: <n>" (field behavioralClassificationScore), 0 = bot
 * to 1 = human; below 0.5 is most likely a bot. The first score appears after
 * 1.5 s and is updated at 4, 7, 10 and 15 s. Until then the score reads "...":
 * that is no verdict, so the page counts as not run. Seen live on 2026-11-11:
 * the score's script (abs.incolumitas.com/lib.js) answered 502, so the score
 * stayed "..." for everyone. `fixtures/incolumitas-pending.txt` is that real
 * capture (trimmed before the IP and fingerprint sections); the human and bot
 * fixtures are hand-edited copies with a made-up score, since no real score
 * could be captured.
 */
export const INCOLUMITAS_HUMAN_MIN = 0.5;

export function parseIncolumitas(text: string): CheckResult {
  const page = 'incolumitas';
  const text_ = typeof text === 'string' ? text : '';
  if (/Behavioral Score:\s*\.\.\.\s*$/m.test(text_)) {
    return {
      page,
      passed: false,
      notRun: true,
      detail: ['no behavioural score (the page still shows "...")'],
    };
  }
  const m =
    /Behavioral Score:\s*(\d+(?:\.\d+)?)/.exec(text_) ??
    /"?behavioralClassificationScore"?\s*[:=]\s*(\d+(?:\.\d+)?)/.exec(text_);
  if (!m) return unparseable(page);
  const score = Number(m[1]);
  if (!Number.isFinite(score) || score > 1) return unparseable(page);
  const passed = score >= INCOLUMITAS_HUMAN_MIN;
  return { page, passed, detail: [`score ${score}`] };
}

export function formatTable(results: CheckResult[]): string {
  const width = Math.max(4, ...results.map((r) => r.page.length));
  return results
    .map((r) =>
      `${r.page.padEnd(width)}  ${r.notRun ? 'NOT RUN' : r.passed ? 'PASS' : 'FAIL'}  ${r.detail.join(', ')}`.trimEnd(),
    )
    .join('\n');
}
