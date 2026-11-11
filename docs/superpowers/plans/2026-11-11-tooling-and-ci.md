# Tooling and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up ESLint, Vitest and Prettier through Nx, plus one GitHub Actions workflow. Its first job works out what a PR changed, so the other jobs run only the checks that change needs, and a `ci-ok` gate job reports the overall result.

**Architecture:** Nx 24.0.2 and pnpm 12 are aligned with 10xjobs. `@nx/eslint` and `@nx/vitest` are added with `nx add`, and the root config is copied from 10xjobs. A small, tested Node script (`scripts/ci-changes.mjs`) turns the PR's changed files into `hooks` / `code` outputs. `ci.yml` has three jobs: `changes`, then `checks` (format check, hook tests, `nx affected`), then `ci-ok`. The pipeline is proven on a throwaway draft PR that is closed without merging.

**Tech Stack:** Nx 24.0.2, pnpm 12.15.0, Node 24, ESLint 9 flat config, Vitest 5, Prettier 3, GitHub Actions, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-10-tooling-and-ci-design.md`

## Global Constraints

- No Nx Cloud: no `nxCloudId`, no `nx fix-ci`, no `start-nx-agents`.
- No secrets in CI. Workflow `permissions` are `contents: read` and `actions: read`, nothing else.
- Third-party actions (anything not `actions/*`) are pinned to a full commit SHA, with the tag in a comment.
- CI runs only dev targets: `lint`, `test`, `build`, `typecheck`, which the slice-01 guard allows.
- When in doubt, a path counts as `code`. Docs means only `docs/**` and `*.md` files.
- Commands use `pnpm` (`pnpm nx …`), never `npx`/`npm`.
- Slice branch: `chore/tooling-and-ci`. Probe branch: `chore/ci-probe`, never merged. Never work on `main`.
- Nx and `@nx/*` 24.0.2; `packageManager` `pnpm@12.15.0`. If pnpm 12 breaks install or Nx, keep `pnpm@10.30.3` and say so in the PR.

## Review Focus

1. **No usable base commit** (base SHA empty, all zeros, or not in the clone, as on a first push): every area counts as changed, so everything runs. Tested in Task 3 (`areasFor` fallback tests).
2. **A deleted or renamed hook file** (for example removing `.claude/hooks/guard.test.mjs`): `hooks` is true. The diff uses `--no-renames` so both old and new paths are listed. Tested in Task 3 (`gitDiffArgs` test).
3. **A PR with both docs and code:** `code` is true. Tested in Task 3.
4. **Config files at the root or in dot-folders** (`pnpm-lock.yaml`, `.prettierrc`, `.github/workflows/ci.yml`, `nx.json`): `code` is true, even though none of them is in a project. Tested in Task 3.
5. **`ci-ok` when another job failed, was cancelled, or `changes` itself failed:** `ci-ok` is red. Only `success` or `skipped` count as passing. Checked on the probe PR in Task 4.

---

### Task 1: Align Nx and pnpm with 10xjobs

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml` (and `nx.json` if the migration touches it)

- [ ] **Step 1: Create the branch**

```bash
git switch -c chore/tooling-and-ci
git add docs/superpowers/specs/2026-11-10-tooling-and-ci-design.md docs/superpowers/plans/2026-11-11-tooling-and-ci.md
git commit -m "docs: slice 02 tooling and CI spec and plan"
```

- [ ] **Step 2: Move Nx to 24.0.2**

Run: `pnpm nx migrate 24.0.2 && pnpm install`. If a `migrations.json` was created, run `pnpm nx migrate --run-migrations`, then delete `migrations.json`.
Expected: `nx` and `@nx/js` are `24.0.2` in `package.json`.

- [ ] **Step 3: Move pnpm to 12.15.0**

Set `"packageManager": "pnpm@12.15.0"` in `package.json`, then run `pnpm --version && pnpm install`.
Expected: `12.15.0`, and install succeeds with an updated lockfile. If not, revert to `pnpm@10.30.3` and note why.

- [ ] **Step 4: Check nothing broke**

Run: `pnpm nx report && pnpm test:hooks`
Expected: Nx reports 24.0.2; every hook test passes.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml nx.json
git commit -m "chore: align Nx 24.0.2 and pnpm 12 with 10xjobs"
```

---

### Task 2: ESLint, Vitest and Prettier through Nx

**Files:**

- Create: `eslint.config.mjs` (copy of `/home/lab/apps/10xjobs/eslint.config.mjs`), `vitest.config.mts` (copy of `/home/lab/apps/10xjobs/vitest.config.mts`)
- Modify: `nx.json`, `package.json`, `.prettierignore`, `CLAUDE.md` (Commands and Stack)

**Interfaces:**

- Produces: inferred targets `lint` (from `@nx/eslint/plugin`) and `test` (from `@nx/vitest`) on any project with the matching config, next to the existing `build`/`typecheck` from `@nx/js/typescript`. Root scripts `lint`, `test`, `build`, `typecheck`, `format`, `format:check`, used by Task 3 and by people.

- [ ] **Step 1: Add the plugins**

Run: `pnpm nx add @nx/eslint && pnpm nx add @nx/vitest`
Expected: both appear in `devDependencies` at 24.0.2 and are registered in `nx.json` `plugins`. Also install whatever 10xjobs has and these need: `eslint`, `@eslint/js`, `typescript-eslint`, `@nx/eslint-plugin`, `eslint-config-prettier`, `vitest`, plus `vite` if `@nx/vitest` warns about a missing peer. Use 10xjobs's version ranges.

- [ ] **Step 2: Set the plugin options in `nx.json`**

- `@nx/eslint/plugin`: `{ "targetName": "lint" }`.
- `@nx/vitest`: `{ "testTargetName": "test", "testMode": "run" }` _(my call: `run`, not 10xjobs's `watch`, so `pnpm test` ends instead of watching)_.
- `namedInputs.production`: copy 10xjobs's list (excludes ESLint config, spec/test files, `tsconfig.spec.json`).
- `namedInputs.sharedGlobals`: `["{workspaceRoot}/.github/workflows/ci.yml"]`.
- `targetDefaults.test.dependsOn`: `["^build"]`.

- [ ] **Step 3: Copy `eslint.config.mjs` and `vitest.config.mts` from 10xjobs unchanged**

- [ ] **Step 4: Add the root scripts to `package.json`**

```json
"lint": "nx run-many -t lint",
"test": "nx run-many -t test",
"build": "nx run-many -t build",
"typecheck": "nx run-many -t typecheck",
"format": "nx format:write",
"format:check": "nx format:check"
```

- [ ] **Step 5: Add `pnpm-lock.yaml` to `.prettierignore`**

- [ ] **Step 6: Check the whole repo's formatting**

Run: `pnpm nx format:check --all`
Expected: no files listed. If any are listed, run `pnpm nx format:write --all` and commit that alone as `style: format the repo with Prettier`, before Step 8.

- [ ] **Step 7: Update `CLAUDE.md`**

In Commands, list `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm typecheck` (all projects), `pnpm format` / `pnpm format:check` (Prettier on changed files; `--all` for everything), and `pnpm test:scripts` (from Task 3). Also say that CI runs `nx affected` for these, only on code changes. In Stack, mark ESLint, Vitest and Prettier as set up.

- [ ] **Step 8: Commit**

```bash
git add nx.json package.json pnpm-lock.yaml eslint.config.mjs vitest.config.mts .prettierignore CLAUDE.md
git commit -m "chore: set up ESLint, Vitest and Prettier through Nx"
```

- [ ] **Step 9: Check the targets on a local, uncommitted probe** (after the commit, so the cleanup can't undo this task)

Run: `pnpm nx g @nx/js:lib packages/ci-probe --linter=eslint --unitTestRunner=vitest --bundler=tsc --no-interactive`, then `pnpm nx show project ci-probe` (or the generated name) and `pnpm lint && pnpm test && pnpm build && pnpm typecheck`.
Expected: the probe has `lint`, `test`, `build`, `typecheck` targets, and all four pass. If a target is missing or fails, fix the config (not the probe), amend nothing, and commit the fix as its own commit.
Then clean up: `git restore . && git clean -fd packages/`. Expected: `git status` is clean.

---

### Task 3: The "what changed" script

**Files:**

- Create: `scripts/ci-changes.mjs`, `scripts/ci-changes.test.mjs`
- Modify: `package.json` (`test:scripts`)

**Interfaces:**

- Produces, in `scripts/ci-changes.mjs` (ESM):
  - `classify(files: string[]) -> { hooks: boolean, code: boolean }`: pure. `hooks` is true when any path starts with `.claude/hooks/`. `code` is true when any path is neither under `docs/` nor ends in `.md`.
  - `gitDiffArgs(base: string, head: string) -> string[]`: `['diff', '--name-only', '--no-renames', `${base}...${head}`]`.
  - `areasFor(base: string | undefined, head: string, listFiles: (base, head) => string[]) -> { hooks, code }`: returns `{ hooks: true, code: true }` when `base` is empty, all zeros (`/^0+$/`), or `listFiles` throws. Otherwise `classify(listFiles(base, head))`.
  - When run directly (`node scripts/ci-changes.mjs <base> <head>`), it calls `areasFor` with a `listFiles` that runs `git` via `execFileSync` with `gitDiffArgs`. It appends `hooks=<bool>` and `code=<bool>` lines to `$GITHUB_OUTPUT` (stdout when unset) and prints the changed files.
  - A comment at the top lists the areas still to come: `database` (slice 08: `libs/database/prisma/**`, migrations, `supabase/**`) and `web` (slice 09: use `nx show projects --affected`, not paths).
- Consumed by: Task 4's `changes` job.

- [ ] **Step 1: Write the failing tests in `scripts/ci-changes.test.mjs`** (`node:test`, `node:assert/strict`)

```js
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
test('diff lists both sides of a rename, against the merge base', () =>
  assert.deepEqual(gitDiffArgs('b', 'h'), [
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
```

- [ ] **Step 2: Add `"test:scripts": "node --test \"scripts/*.test.mjs\""` to `package.json`, then run it**

Run: `pnpm test:scripts`
Expected: FAIL, module `./ci-changes.mjs` not found.

- [ ] **Step 3: Implement `scripts/ci-changes.mjs` per the Interfaces block**

Detect "run directly" with `import.meta.url === pathToFileURL(process.argv[1]).href`.

- [ ] **Step 4: Run the tests, then the script against this branch**

Run: `pnpm test:scripts && node scripts/ci-changes.mjs main HEAD`
Expected: all tests pass; the script prints `hooks=false` and `code=true`, plus this branch's changed files.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci-changes.mjs scripts/ci-changes.test.mjs package.json
git commit -m "feat(ci): work out which areas a change touches"
```

---

### Task 4: The CI workflow

**Files:**

- Create: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `scripts/ci-changes.mjs` outputs `hooks`, `code` (Task 3); root scripts `test:hooks`, `test:scripts` (Tasks 2–3).
- Produces: check names `changes`, `checks`, `ci-ok`. `ci-ok` is the single check a future branch protection requires. Slices 08 and 09 add their jobs to its `needs`.

- [ ] **Step 1: Write `ci.yml`**

- `name: CI`. `on`: `pull_request` with `branches: [main]`; `push` with `branches: [main]`.
- `concurrency`: `group: ci-${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.
- `permissions`: `actions: read`, `contents: read`.
- Shared setup (in each job that installs): `actions/checkout@v7` with `fetch-depth: 0` and `filter: tree:0`, `pnpm/action-setup@v6`, `actions/setup-node@v6` with `node-version: 24` and `cache: pnpm`, `pnpm install --frozen-lockfile`.
- **`changes`**: checkout only (no install). Run `node scripts/ci-changes.mjs "$BASE" "$HEAD"`, with `BASE` = `github.event.pull_request.base.sha || github.event.before` and `HEAD` = `github.sha`, passed through `env:`, never inlined into the script. Outputs `hooks` and `code` from the step. A comment block names the `database` and `web` jobs still to come and the slice that adds each.
- **`checks`** (`needs: changes`): shared setup, then `nrwl/nx-set-shas` pinned by SHA (look up the latest v4 tag's commit with `gh api repos/nrwl/nx-set-shas/git/ref/tags/<tag>`). Then `actions/cache` on `.nx/cache`, with key `nx-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-${{ github.sha }}` and restore-keys `nx-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-` and `nx-${{ runner.os }}-`. Steps:
  - `pnpm nx format:check --base="$NX_BASE" --head="$NX_HEAD"`, always;
  - `pnpm test:hooks` when `needs.changes.outputs.hooks == 'true' || github.event_name == 'push'`;
  - `pnpm test:scripts` and `pnpm nx affected -t lint test build typecheck` when `needs.changes.outputs.code == 'true'`.
- **`ci-ok`** (`needs: [changes, checks]`, `if: always()`): one step with `NEEDS: ${{ toJSON(needs) }}` in `env`, running `echo "$NEEDS" | jq -e 'all(.[]; .result == "success" or .result == "skipped")'`. Print the results first so a red run shows which job failed.
- Every job has a `timeout-minutes` (`changes` 5, `checks` 20, `ci-ok` 2) _(my call)_.

- [ ] **Step 2: Lint the workflow**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -color` (if Docker isn't available, say so and skip).
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat(ci): run only the checks a change needs, behind a ci-ok gate"
```

---

### Task 5: Prove it on a throwaway PR, then open the slice PR

The slice PR is opened first. Its own run proves the empty-workspace case. The probe PR proves the rest.

- [ ] **Step 1: Push the slice branch and open its PR**

```bash
git push -u origin chore/tooling-and-ci
gh pr create --title "chore: tooling and CI (slice 02)" --body "<summary, spec and plan links; probe evidence to follow>"
```

Run: `gh pr checks --watch`
Expected: `changes` (code=true), `checks` (format check and `nx affected` with nothing to run), and `ci-ok` are all green.

- [ ] **Step 2: Create the probe on its own branch**

```bash
git switch -c chore/ci-probe
pnpm nx g @nx/js:lib packages/ci-probe --linter=eslint --unitTestRunner=vitest --bundler=tsc --no-interactive
git add -A && git commit -m "test(ci): probe project, not for merge"
git push -u origin chore/ci-probe
gh pr create --draft --title "DO NOT MERGE: CI probe for slice 02" --body "Throwaway. Proves the CI from #<slice PR>. Closed unmerged."
```

Expected: `checks` runs lint, test, build and typecheck for the probe, and `ci-ok` is green. Record the run URL.

- [ ] **Step 3: A failure turns `ci-ok` red**

Add an ESLint error to the probe (for example an unused `let` with `prefer-const`), commit, push.
Expected: `checks` red, `ci-ok` red. Record the run URL.

- [ ] **Step 4: A new push cancels the older run**

Revert the error, commit, push, then immediately add and push another trivial probe change.
Expected: the first of the two runs is shown as cancelled, `ci-ok` on that run is not green, and the latest run is green. Record both URLs.

- [ ] **Step 5: Close the probe PR unmerged**

Run: `gh pr close <probe PR> --comment "Probe done; evidence linked from #<slice PR>."` then `git switch chore/tooling-and-ci`.
Tell the author to delete the remote `chore/ci-probe` branch (Claude can't).

- [ ] **Step 6: Fill in the slice PR's evidence**

Run: `gh pr edit <slice PR> --body "<summary + links to the runs from Steps 1–4>"`. Note in the body: the docs-only skip is covered by `scripts/ci-changes.test.mjs` and gets its first live run on the first docs PR after merge, because any PR opened before merge contains `ci.yml` and counts as code. Mention the pnpm fallback if Task 1 used it. Any CI fix the probe uncovered goes on `chore/tooling-and-ci` as its own commit, and Steps 2–4 are repeated on a fresh probe commit.
