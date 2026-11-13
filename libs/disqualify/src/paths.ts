import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file sits one folder below the lib root (src/ or dist/), and the lib
// sits at libs/disqualify, so three levels up is the repo root in both cases.
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(dirname(dirname(here)));

export const DEFAULT_RULES_PATH = join(REPO_ROOT, 'private', 'disqualify.yaml');
