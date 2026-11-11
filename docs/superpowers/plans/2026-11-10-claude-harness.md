# Claude Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a guard hook, a format hook, permissions and `CLAUDE.md` rules in place so Claude can't read secrets or `private/`, can't push `main` or merge, and can't launch a real (non-dry-run) LinkedIn run.

**Architecture:** Copy 10xjobs's `.claude/hooks/guard.mjs`, `format.mjs` and `guard.test.mjs` unchanged, then extend `guard.mjs` with two new Bash rules: `ghProblem` (merge and retarget paths through `gh`) and `runnerProblem` (launches of the runner without `--dry-run`). Both reuse the existing `parse` / `commandIndex` / `nestedCommand` helpers. The runner name is an empty constant until slice 03, and tests inject a fake one.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Prettier, pnpm, Claude Code hooks.

**Spec:** `docs/superpowers/specs/2026-11-10-claude-harness-design.md`

## Global Constraints

- No new dependencies. `test:hooks` is `node --test ".claude/hooks/*.test.mjs"`.
- No 10xjobs guard rule is weakened, and every copied 10xjobs test still passes.
- Commands use `pnpm` (`pnpm nx …`, `pnpm test:hooks`), never `npx`/`npm`.
- `.claude/settings.json` keeps its existing `extraKnownMarketplaces` and `enabledPlugins` entries.
- Redacted reports folder: `run-reports/` at the repo root, git-ignored, readable by Claude.
- Dev targets that never count as a runner launch: `build`, `test`, `lint`, `typecheck`.
- Work on a branch (`chore/claude-harness`), never on `main`.

## Review Focus

1. `--dry-run=false`, or `--dry-run` placed before the launch token (`node --dry-run apps/fake-runner/main.js apply x`), must be blocked. Only a bare `--dry-run` token after the launch token counts. Tested in Task 3.
2. Launching from inside the app folder (`cd apps/fake-runner && node dist/main.js apply x`) must be blocked: a `cd` into `apps/<name>` earlier in the same command makes later `node`/`tsx`/`ts-node` file launches count as runner launches. Tested in Task 3.
3. Combined flag forms on `gh api` (`-XPOST`, `--method=PATCH`, `--method POST`) must be blocked, and `gh api repos/o/r/pulls/1/comments` (a read) allowed. Tested in Task 2.
4. `gh` rules must also apply inside `bash -c "…"`, after wrappers (`env`, `timeout`) and after `&&`. Tested in Task 2.
5. With no runner name configured (the slice 01 default), no command is blocked by the runner rule. Otherwise the guard would get in the way before slice 03 exists. Tested in Task 3.

---

### Task 1: Copy the 10xjobs harness

**Files:**

- Create: `.claude/hooks/guard.mjs`, `.claude/hooks/format.mjs`, `.claude/hooks/guard.test.mjs` (copied from `/home/lab/apps/10xjobs/.claude/hooks/`)
- Modify: `.claude/settings.json`, `package.json`, `.gitignore`, `CLAUDE.md` (Guardrails section, plus a new Commands section)

**Interfaces:**

- Produces: `evaluate({ tool_name, tool_input }) -> { block: boolean, reason?: string }` in `guard.mjs`, plus the internal helpers `parse`, `commandIndex`, `nestedCommand`, `REDIRECT` that Tasks 2–3 reuse.

- [ ] **Step 1: Create the branch and copy the three hook files unchanged**

```bash
git switch -c chore/claude-harness
mkdir -p .claude/hooks
cp /home/lab/apps/10xjobs/.claude/hooks/{guard.mjs,format.mjs,guard.test.mjs} .claude/hooks/
```

- [ ] **Step 2: Add the `run-reports` tests to `guard.test.mjs`** (in the `private data` test)

```js
assert.equal(
  blocked('Read', { file_path: '/repo/run-reports/r1.json' }),
  false,
);
assert.equal(blocked('Bash', { command: 'cat run-reports/r1.json' }), false);
```

- [ ] **Step 3: Add the script to `package.json`:** `"test:hooks": "node --test \".claude/hooks/*.test.mjs\""`

- [ ] **Step 4: Merge permissions and hooks into `.claude/settings.json`**

Keep the existing keys. Add `$schema`, plus `permissions` and `hooks` exactly as in `/home/lab/apps/10xjobs/.claude/settings.json`, except:

- allow: replace each `npx nx <x>:*` with `pnpm nx <x>:*` for `lint`, `test`, `typecheck`, `build`, `run-many`, `affected`; replace `npm run test:hooks` with `pnpm test:hooks`; keep the git read-only entries as they are.
- ask: `Bash(git push:*)`, `Bash(gh pr create:*)`.
- deny: unchanged (`Read(./.env)`, `Read(./.env.local)`, `Read(./private/**)`).

- [ ] **Step 5: Add `run-reports/` to `.gitignore`** under the `# env and private data` block.

- [ ] **Step 6: Update `CLAUDE.md`**

Replace the `## Guardrails` section with 10xjobs's guardrail bullets (see `/home/lab/apps/10xjobs/CLAUDE.md`, "Guardrails"), and keep the existing two 10xapply bullets on credentials and cookies. Add one bullet: "`run-reports/` holds redacted run reports (no personal facts, no cookies). It is git-ignored and Claude may read it." After `## Workflow`, add a `## Commands` section with one line: `pnpm test:hooks` runs the guard hook tests.

- [ ] **Step 7: Run the tests**

Run: `pnpm test:hooks`
Expected: all tests pass, with 0 failures.

- [ ] **Step 8: Check that the hook works through the CLI entry point**

Run: `echo '{"tool_name":"Read","tool_input":{"file_path":"private/x"}}' | node .claude/hooks/guard.mjs; echo $?`
Expected: prints `Blocked: private/x …` and then `2`.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers
git commit -m "docs: add Claude harness spec and plan"
git add .claude package.json .gitignore CLAUDE.md
git commit -m "chore: add Claude guard and format hooks from 10xjobs"
```

---

### Task 2: Block merging and retargeting through `gh`

**Files:**

- Modify: `.claude/hooks/guard.mjs`, `.claude/hooks/guard.test.mjs`, `CLAUDE.md` (Guardrails)

**Interfaces:**

- Consumes: `parse`, `commandIndex`, `nestedCommand` from Task 1.
- Produces: `ghProblem(command: string) -> string | null` (not exported). `evaluate` calls it right after `gitPushProblem` and blocks with reason `` `gh blocked: ${problem}. Claude may only open PRs to main; the human merges.` ``

- [ ] **Step 1: Write the failing tests**

```js
test('bash: gh merge and retarget paths are blocked', () => {
  for (const command of [
    'gh pr merge 12',
    'gh pr merge --squash --auto',
    'gh pr edit 12 --base dev',
    'gh pr edit 12 -B dev',
    'gh pr review 12 --approve',
    'gh pr review 12 -a',
    'gh pr create --base dev --title x --body y',
    'gh pr create -B dev',
    'gh pr create --base=dev',
    'gh api -X PUT repos/o/r/pulls/1/merge',
    'gh api -XPOST repos/o/r/issues/1/comments',
    'gh api --method=PATCH repos/o/r/pulls/1',
    'gh api --method POST repos/o/r/pulls',
    'gh api repos/o/r/pulls -f base=main',
    'gh api graphql -F query=@q.graphql',
    'gh api repos/o/r/pulls/1/merge --input body.json',
    'bash -c "gh pr merge 1"',
    'git status && gh pr merge 1',
    'env GH_TOKEN=x gh pr merge 1',
    'timeout 30 gh pr merge 1',
  ]) {
    assert.equal(blocked('Bash', { command }), true, command);
  }
});

test('bash: gh reads and PRs to main are allowed', () => {
  for (const command of [
    'gh pr create --title x --body y',
    'gh pr create --base main --title x',
    'gh pr create -B main',
    'gh pr view 12',
    'gh pr list',
    'gh pr edit 12 --title "new title"',
    'gh pr review 12 --comment -b "looks fine"',
    'gh api repos/o/r/pulls/1/comments',
    'gh api -X GET repos/o/r/pulls -f state=open',
    'gh api --method=GET repos/o/r/pulls',
    'git commit -m "gh pr merge later"',
  ]) {
    assert.equal(blocked('Bash', { command }), false, command);
  }
});

test('reasons: gh', () => {
  const r = evaluate({
    tool_name: 'Bash',
    tool_input: { command: 'gh pr merge 1' },
  });
  assert.match(r.reason, /gh blocked/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test:hooks`
Expected: the two new blocking tests and `reasons: gh` fail; every other test passes.

- [ ] **Step 3: Implement `ghProblem(command)` in `guard.mjs`**

Follow `gitPushProblem`'s shape: recurse into `nestedCommand`, and find the command word with `commandIndex`. Ignore `REDIRECT` tokens and their targets. A flag's value may come joined (`-XPOST`, `--method=POST`, `--base=dev`) or as the next token. Rules:

- `gh pr merge` → `'merging is for the human'`.
- `gh pr edit` with `--base`/`-B` → `'retargeting a PR is not allowed'`.
- `gh pr review` with `--approve`/`-a` → `'approving a PR is not allowed'`.
- `gh pr create` with a base other than `main` → `'PRs may only target main'`.
- `gh api`: the method is the `-X`/`--method` value, uppercased. If no method is given, it is `POST` when any of `-f`, `-F`, `--field`, `--raw-field`, `--input` is present, and `GET` otherwise. Any method other than `GET` → `'gh api write calls are not allowed'`.

If an unterminated quote is present and the raw command matches `/\bgh\b[^\n;&|]*\b(merge|api|--base|-B|--approve)\b/`, block with `'a gh call inside an unterminated quote cannot be checked'`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test:hooks`
Expected: all pass.

- [ ] **Step 5: Update `CLAUDE.md`'s Guardrails push bullet** to add: "`guard.mjs` also blocks `gh pr merge`, approving or retargeting PRs, PRs to anything but `main`, and `gh api` write calls."

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks CLAUDE.md
git commit -m "feat(guard): block merging and retargeting PRs through gh"
```

---

### Task 3: Block real runner launches

**Files:**

- Modify: `.claude/hooks/guard.mjs`, `.claude/hooks/guard.test.mjs`, `CLAUDE.md` (a new "Running against LinkedIn" section)

**Interfaces:**

- Consumes: `parse`, `commandIndex`, `nestedCommand`, `REDIRECT` from Task 1.
- Produces:
  - exported constants `RUNNER_NAME = ''`, `RUNNER_SAFE_SUBCOMMANDS = []`, `DEV_TARGETS = ['build', 'test', 'lint', 'typecheck']`. Slice 03 fills in the first two;
  - `evaluate(event, { runnerName = RUNNER_NAME, safeSubcommands = RUNNER_SAFE_SUBCOMMANDS } = {})`, so existing one-argument calls keep working;
  - `runnerProblem(command: string, runnerName: string, safeSubcommands: string[]) -> string | null`, which returns `null` immediately when `runnerName` is `''`;
  - block reason: `` `Runner blocked: ${problem}. Claude may only start --dry-run runs, and only when the author asks (see CLAUDE.md).` ``

- [ ] **Step 1: Write the failing tests**

```js
const runner = {
  runnerName: 'fake-runner',
  safeSubcommands: ['check-session'],
};
const runnerBlocked = (command, opts = runner) =>
  evaluate({ tool_name: 'Bash', tool_input: { command } }, opts).block;

test('runner: real launches are blocked', () => {
  for (const command of [
    'pnpm nx run fake-runner:apply https://x/jobs/1',
    'pnpm nx apply fake-runner',
    'pnpm exec nx run fake-runner:apply',
    'npx nx run fake-runner:apply',
    'pnpm nx run-many -t apply',
    'pnpm nx affected --targets=lint,apply',
    'node apps/fake-runner/dist/main.js apply https://x/jobs/1',
    'tsx apps/fake-runner/src/main.ts apply x',
    'pnpm exec tsx apps/fake-runner/src/main.ts apply x',
    'ts-node ./apps/fake-runner/src/main.ts apply x',
    'node --dry-run apps/fake-runner/main.js apply x',
    'node apps/fake-runner/main.js apply x --dry-run=false',
    'bash -c "node apps/fake-runner/main.js apply x"',
    'cd apps/fake-runner && node dist/main.js apply x',
    "node apps/fake-runner/main.js apply 'unterminated",
  ]) {
    assert.equal(runnerBlocked(command), true, command);
  }
});

test('runner: dry runs, safe subcommands and development pass', () => {
  for (const command of [
    'pnpm nx run fake-runner:apply --dry-run',
    'pnpm nx run fake-runner:apply -- https://x/jobs/1 --dry-run',
    'node apps/fake-runner/dist/main.js apply https://x/jobs/1 --dry-run',
    'node apps/fake-runner/dist/main.js --dry-run apply x',
    'pnpm nx run fake-runner:check-session',
    'node apps/fake-runner/dist/main.js check-session',
    'pnpm nx test fake-runner',
    'pnpm nx run fake-runner:build',
    'pnpm nx lint fake-runner',
    'pnpm nx run-many -t lint test build typecheck',
    'git add apps/fake-runner',
    'git diff apps/fake-runner',
    'cat apps/fake-runner/src/main.ts',
    'grep -r apply apps/fake-runner/src',
    'git commit -m "fake-runner: fix apply step"',
  ]) {
    assert.equal(runnerBlocked(command), false, command);
  }
});

test('runner: no name configured blocks nothing', () => {
  assert.equal(
    runnerBlocked('node apps/fake-runner/main.js apply x', {}),
    false,
  );
  assert.equal(runnerBlocked('pnpm nx run-many -t apply', {}), false);
});

test('reasons: runner', () => {
  const r = evaluate(
    {
      tool_name: 'Bash',
      tool_input: { command: 'pnpm nx run fake-runner:apply' },
    },
    runner,
  );
  assert.match(r.reason, /Runner blocked/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test:hooks`
Expected: `runner: real launches are blocked` and `reasons: runner` fail; the rest pass.

- [ ] **Step 3: Implement `runnerProblem` in `guard.mjs` and call it from `evaluate`'s Bash branch, after `ghProblem`**

Rules, applied to each segment from `parse`, recursing into `nestedCommand`:

- **Nx launch:** the command word is `nx`, or `pnpm`/`npx` followed by `nx`, or `pnpm exec nx`. Read the Nx form:
  - `run <proj>:<target>[:<config>]`;
  - `run-many`/`affected` with targets from `-t`/`--target`/`--targets` (space- or comma-separated, joined or separate). A non-dev target here → blocked as `'run-many with a non-dev target may launch the runner'`, whatever follows;
  - `<proj>:<target>`;
  - `<target> <proj>`.
    If the project is `runnerName` and the target is not in `DEV_TARGETS`, the launch token is the `proj:target` (or target) token and the subcommand is the target.
- **File launch:** the command word (after `pnpm exec` / `npx`) is `node`, `tsx` or `ts-node`, and its first non-flag argument is a path under `apps/<runnerName>/` (after `./` is stripped). Also a launch: any relative path, when an earlier segment in the same command was `cd` into a path containing `apps/<runnerName>`. The launch token is that path. The subcommand is the first non-flag token after it.
- A launch is allowed when the subcommand is in `safeSubcommands`, or when a token exactly equal to `--dry-run` appears after the launch token. Otherwise → `'a real run is not allowed'`.
- If an unterminated quote is present and the raw command contains `runnerName`, block with `'a runner command inside an unterminated quote cannot be checked'`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test:hooks`
Expected: all pass.

- [ ] **Step 5: Add a `## Running against LinkedIn` section to `CLAUDE.md`** after Guardrails, with these points:
  - The author runs every real submit and takes over when a form goes wrong.
  - Claude debugs from `run-reports/` and from scrubbed page snapshots committed as fixtures.
  - Claude may start a `--dry-run` against a real job only when the author asks in that session, and only a few a day.
  - `guard.mjs` blocks runner launches without `--dry-run`. `RUNNER_NAME` and `RUNNER_SAFE_SUBCOMMANDS` are filled in by slice 03.
  - From slice 07, a real submit also asks for a typed confirmation at the keyboard. Slice 14 relaxes both locks.

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks CLAUDE.md
git commit -m "feat(guard): block runner launches without --dry-run"
```

---

### Task 4: Final check and PR

- [ ] **Step 1: Run the full suite and Prettier check**

Run: `pnpm test:hooks && pnpm exec prettier --check .claude CLAUDE.md package.json`
Expected: all tests pass; Prettier reports no issues.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin chore/claude-harness
gh pr create --title "chore: Claude harness (slice 01)" --body "<summary + spec link>"
```
