import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../deploy/api/render-site.sh', import.meta.url),
);

function render(...args) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
}

const site = (host) =>
  `${host} {\n\tencode gzip\n\treverse_proxy xapply-api:3000\n}\n`;

test('render-site: renders the sslip example', () => {
  const r = render('xapply.203-0-113-10.sslip.io');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, site('xapply.203-0-113-10.sslip.io'));
  assert.equal(r.stderr, '');
});

test('render-site: renders a real domain', () => {
  const r = render('xapply.example.com');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, site('xapply.example.com'));
});

for (const bad of [
  'https://xapply.1-2-3-4.sslip.io/',
  'xapply.1-2-3-4.sslip.io\n',
  '',
  'a b',
  'x;rm -rf ~',
  'xapply.1-2-3-4.sslip.io/path',
]) {
  test(`render-site: refuses ${JSON.stringify(bad)} without echoing it`, () => {
    const r = render(bad);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'invalid hostname\n');
  });
}

test('render-site: refuses a missing argument', () => {
  const r = render();
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'invalid hostname\n');
});
