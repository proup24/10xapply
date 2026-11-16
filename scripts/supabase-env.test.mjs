import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./supabase-env.sh', import.meta.url));

// Runs the script with a stand-in `pnpm` first on PATH, so no stack is needed.
function run(fakePnpm) {
  const bin = mkdtempSync(join(tmpdir(), 'supabase-env-'));
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env bash\n${fakePnpm}\n`);
  chmodSync(join(bin, 'pnpm'), 0o755);
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
}

test('supabase-env: prints the exports for a running stack', () => {
  const result = run(
    `printf 'API_URL="http://127.0.0.1:55321"\\nSERVICE_ROLE_KEY="service"\\nANON_KEY="anon"\\n'`,
  );
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    'export SUPABASE_URL=http://127.0.0.1:55321 SUPABASE_SERVICE_ROLE_KEY=service SUPABASE_PUBLISHABLE_KEY=anon\n',
  );
});

test('supabase-env: prefers the publishable key', () => {
  const result = run(
    `printf 'API_URL="u"\\nSERVICE_ROLE_KEY="s"\\nANON_KEY="anon"\\nPUBLISHABLE_KEY="pub"\\n'`,
  );
  assert.match(result.stdout, /SUPABASE_PUBLISHABLE_KEY=pub\n$/);
});

test('supabase-env: a failing status prints the friendly message', () => {
  const result = run('echo "failed to inspect container" >&2; exit 1');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /the Supabase stack is not running/);
});

test('supabase-env: a status without the values prints the friendly message', () => {
  const result = run('echo "DB_URL=x"');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the Supabase stack is not running/);
});
