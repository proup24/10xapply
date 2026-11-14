import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

export type JobStatus = 'submitting' | 'applied' | 'disqualified' | 'failed';

export interface StatusChange {
  status: JobStatus;
  source?: 'submit' | 'linkedin-marker'; // applied only
  reason?: string; // failed and disqualified only
}
export interface HistoryEvent extends StatusChange {
  at: string;
  runStartedAt: string;
}
export interface JobEntry extends StatusChange {
  updatedAt: string;
  history: HistoryEvent[];
}
export interface JobRecord {
  version: 1;
  jobs: Record<string, JobEntry>;
}

/** The file is unreadable or fails the schema. */
export class RecordError extends Error {}

export const DEFAULT_RECORD_PATH = join(
  REPO_ROOT,
  'private',
  'applications.json',
);

const statusSchema = z.enum([
  'submitting',
  'applied',
  'disqualified',
  'failed',
]);
const changeShape = {
  status: statusSchema,
  source: z.enum(['submit', 'linkedin-marker']).optional(),
  reason: z.string().optional(),
};
const historySchema = z.strictObject({
  ...changeShape,
  at: z.string(),
  runStartedAt: z.string(),
});
const entrySchema = z.strictObject({
  ...changeShape,
  updatedAt: z.string(),
  history: z.array(historySchema),
});
const recordSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.record(z.string().regex(/^\d+$/), entrySchema),
});

export function parseRecord(text: string): JobRecord {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RecordError('applications record is not valid JSON');
  }
  const parsed = recordSchema.safeParse(json);
  if (!parsed.success) {
    throw new RecordError('applications record fails its schema');
  }
  return parsed.data as JobRecord;
}

function keep(c: StatusChange): StatusChange {
  const out: StatusChange = { status: c.status };
  if (c.status === 'applied' && c.source) out.source = c.source;
  if ((c.status === 'failed' || c.status === 'disqualified') && c.reason) {
    out.reason = c.reason;
  }
  return out;
}

export function withChange(
  r: JobRecord,
  jobId: string,
  c: StatusChange,
  at: string,
  runStartedAt: string,
): JobRecord {
  const change = keep(c);
  const prev = r.jobs[jobId];
  const entry: JobEntry = {
    ...change,
    updatedAt: at,
    history: [...(prev?.history ?? []), { ...change, at, runStartedAt }],
  };
  return { ...r, jobs: { ...r.jobs, [jobId]: entry } };
}

export type StartDecision =
  'go' | 'refuse-applied' | 'refuse-disqualified' | 'settle-leftover';

export function startDecision(
  entry: JobEntry | null,
  dryRun: boolean,
): StartDecision {
  switch (entry?.status) {
    case 'applied':
      return 'refuse-applied';
    case 'disqualified':
      return 'refuse-disqualified';
    case 'submitting':
      return dryRun ? 'go' : 'settle-leftover';
    default:
      return 'go';
  }
}

export function disqualifiedReason(c: {
  kind: string;
  countries: string[];
}): string {
  return `${c.kind}:${c.countries.length ? c.countries.join(',') : 'unclear'}`;
}

export interface RecordStore {
  get(jobId: string): JobEntry | null;
  set(jobId: string, c: StatusChange, runStartedAt: string): JobEntry;
}

function load(path: string): JobRecord {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, jobs: {} };
    }
    throw new RecordError('applications record is unreadable');
  }
  return parseRecord(text);
}

/** Flush the directory entry so the rename survives a power loss. */
function syncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, 'r');
  } catch (e) {
    if (DIR_SYNC_REFUSED.has((e as NodeJS.ErrnoException).code ?? '')) return;
    throw e;
  }
  try {
    fsyncSync(fd);
  } catch (e) {
    if (!DIR_SYNC_REFUSED.has((e as NodeJS.ErrnoException).code ?? '')) {
      throw e;
    }
  } finally {
    closeSync(fd);
  }
}
const DIR_SYNC_REFUSED = new Set(['EISDIR', 'EINVAL', 'EPERM']);

export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    syncDir(dirname(path));
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw e;
  }
}

export function openRecord(
  path: string = DEFAULT_RECORD_PATH,
  now: () => Date = () => new Date(),
): RecordStore {
  load(path); // fail fast on a bad file
  return {
    get: (jobId) => load(path).jobs[jobId] ?? null,
    set(jobId, c, runStartedAt) {
      const next = withChange(
        load(path),
        jobId,
        c,
        now().toISOString(),
        runStartedAt,
      );
      writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
      return next.jobs[jobId] as JobEntry;
    },
  };
}
