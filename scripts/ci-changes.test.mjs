import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, gitDiffArgs, areasFor } from './ci-changes.mjs';

test('docs only', () =>
  assert.deepEqual(
    classify(['docs/roadmap/README.md', 'CLAUDE.md', 'apps/web/DESIGN.md']),
    { hooks: false, code: false },
  ));
test('docs plus code', () =>
  assert.deepEqual(classify(['docs/a.md', 'packages/x/src/index.ts']), {
    hooks: false,
    code: true,
  }));
test('root and dot-folder config counts as code', () => {
  for (const f of [
    'pnpm-lock.yaml',
    '.prettierrc',
    '.github/workflows/ci.yml',
    'nx.json',
    'package.json',
    'scripts/ci-changes.mjs',
  ])
    assert.equal(classify([f]).code, true, f);
});
test('any hooks file sets hooks, even a markdown one', () => {
  assert.equal(classify(['.claude/hooks/guard.mjs']).hooks, true);
  assert.equal(classify(['.claude/hooks/README.md']).hooks, true);
  assert.equal(classify(['.claude/settings.json']).hooks, false);
});
test('no files', () =>
  assert.deepEqual(classify([]), { hooks: false, code: false }));
test('diff lists both sides of a rename, against the merge base, unquoted paths', () =>
  assert.deepEqual(gitDiffArgs('b', 'h'), [
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-only',
    '--no-renames',
    'b...h',
  ]));
test('no usable base: everything changed', () => {
  const never = () => {
    throw new Error('should not list');
  };
  for (const base of [
    undefined,
    '',
    '0000000000000000000000000000000000000000',
  ])
    assert.deepEqual(areasFor(base, 'h', never), { hooks: true, code: true });
  assert.deepEqual(
    areasFor('b', 'h', () => {
      throw new Error('bad object');
    }),
    { hooks: true, code: true },
  );
});
test('normal base uses the listed files', () =>
  assert.deepEqual(
    areasFor('b', 'h', () => ['docs/x.md']),
    { hooks: false, code: false },
  ));
