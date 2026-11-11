export interface CheckResult {
  page: string;
  passed: boolean;
  detail: string[];
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

export function formatTable(results: CheckResult[]): string {
  const width = Math.max(4, ...results.map((r) => r.page.length));
  return results
    .map((r) =>
      `${r.page.padEnd(width)}  ${r.passed ? 'PASS' : 'FAIL'}  ${r.detail.join(', ')}`.trimEnd(),
    )
    .join('\n');
}
