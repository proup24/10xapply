import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionResult } from '../session/classify.js';

/** <workspace>/run-reports, resolved from this file, not the cwd. */
export const REPORTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'run-reports',
);

/** First path segment only: '/in/abc/' becomes '/in/'. Never the full path. */
export function pathPrefix(path: string): string {
  const first = path.split('/')[1];
  return first ? `/${first}/` : '/';
}

export interface SessionReport {
  kind: 'session';
  startedAt: string;
  result: SessionResult;
  pathPrefix: string | null;
  stopReason?: string;
  timings: { loadMs: number; totalMs: number };
}

export function writeRunReport(
  r: SessionReport,
  dir: string = REPORTS_DIR,
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `session-${r.startedAt.replaceAll(':', '-')}.json`);
  writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  return file;
}
