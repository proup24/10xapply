// Works out which areas of the repo a change touches, for the CI `changes` job.
// Node built-ins only: it runs on a bare runner before any `pnpm install`.
//
// Areas still to come:
// - `web` (slice 09): use `nx show projects --affected`, not paths
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DATABASE_PREFIXES = [
  'libs/database/',
  'apps/db-tests/',
  'apps/api/',
  'supabase/',
];
const DEPLOY_PREFIXES = ['deploy/'];
const DEPLOY_FILES = ['scripts/deploy-api-check.sh'];
const DATABASE_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'scripts/supabase-env.sh',
  'scripts/ensure-signing-key.sh',
];

export function classify(files) {
  return {
    hooks: files.some((f) => f.startsWith('.claude/hooks/')),
    code: files.some((f) => !f.startsWith('docs/') && !f.endsWith('.md')),
    database: files.some(
      (f) =>
        DATABASE_PREFIXES.some((p) => f.startsWith(p)) ||
        DATABASE_FILES.includes(f),
    ),
    deploy: files.some(
      (f) =>
        DEPLOY_PREFIXES.some((p) => f.startsWith(p)) ||
        DEPLOY_FILES.includes(f),
    ),
  };
}

export function gitDiffArgs(base, head) {
  return [
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-only',
    '--no-renames',
    `${base}...${head}`,
  ];
}

export function areasFor(base, head, listFiles) {
  if (!base || /^0+$/.test(base))
    return { hooks: true, code: true, database: true, deploy: true };
  let files;
  try {
    files = listFiles(base, head);
  } catch {
    return { hooks: true, code: true, database: true, deploy: true };
  }
  return classify(files);
}

function listFilesWithGit(base, head) {
  const out = execFileSync('git', gitDiffArgs(base, head), {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

function main() {
  const [base, head] = process.argv.slice(2);
  let files = [];
  let fallback = '';
  const areas = areasFor(base, head, (b, h) => {
    try {
      files = listFilesWithGit(b, h);
      return files;
    } catch (err) {
      fallback = `git diff failed (${err.message.split('\n')[0]})`;
      throw err;
    }
  });
  if (!base || /^0+$/.test(base)) fallback = 'no usable base commit';
  if (fallback) console.log(`${fallback}: treating everything as changed`);
  console.log(`Changed files (${files.length}):`);
  for (const f of files) console.log(f);
  const lines = `hooks=${areas.hooks}\ncode=${areas.code}\ndatabase=${areas.database}\ndeploy=${areas.deploy}\n`;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
