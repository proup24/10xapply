import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** <workspace>/private/snapshots: raw page saves. Only the author reads these. */
export const RAW_SNAPSHOTS_DIR = join(REPO_ROOT, 'private', 'snapshots');

/** <workspace>/snapshots: scrubbed copies Claude may read. */
export const SCRUBBED_SNAPSHOTS_DIR = join(REPO_ROOT, 'snapshots');
