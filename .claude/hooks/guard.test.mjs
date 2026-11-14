import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './guard.mjs';

const blocked = (tool_name, tool_input) =>
  evaluate({ tool_name, tool_input }).block;

test('secrets via file tools', () => {
  assert.equal(blocked('Read', { file_path: '/repo/.env' }), true);
  assert.equal(blocked('Read', { file_path: '/repo/.env.local' }), true);
  assert.equal(
    blocked('Edit', { file_path: '/repo/apps/xjobs/.env.production' }),
    true,
  );
  assert.equal(blocked('Read', { file_path: '/repo/.env.example' }), false);
  assert.equal(blocked('Write', { file_path: '/repo/.env.example' }), false);
  assert.equal(
    blocked('Read', { file_path: '/repo/src/environment.ts' }),
    false,
  );
  assert.equal(blocked('Grep', { pattern: 'KEY', path: '/repo/.env' }), true);
  assert.equal(blocked('Glob', { pattern: '**/.env*' }), true);
  assert.equal(blocked('Grep', { pattern: 'x', glob: '**/.env*' }), true);
});

test('private data', () => {
  assert.equal(
    blocked('Read', { file_path: '/home/u/repo/private/cv.md' }),
    false,
  );
  assert.equal(
    blocked('Read', { file_path: '/repo/private/applications.json' }),
    false,
  );
  assert.equal(blocked('Grep', { pattern: 'x', path: 'private' }), false);
  assert.equal(blocked('Glob', { pattern: 'private/**' }), false);
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    for (const p of [
      '/repo/private/applications.json',
      '/repo/private/applications.json.tmp',
    ]) {
      assert.equal(
        blocked(tool, { file_path: p, notebook_path: p }),
        true,
        `${tool} ${p}`,
      );
    }
  }
  assert.equal(
    blocked('Write', { file_path: '/repo/private/fact-bank.yaml' }),
    false,
  );
  assert.equal(
    blocked('Edit', { file_path: '/repo/private/fact-bank.yaml' }),
    false,
  );
  // only the record in the private folder is protected
  assert.equal(
    blocked('Write', { file_path: '/repo/apps/runner/applications.json' }),
    false,
  );
  assert.equal(
    blocked('Read', { file_path: '/repo/apps/private-api/x.ts' }),
    false,
  );
  // Grep's pattern is a content regex, not a path
  assert.equal(blocked('Grep', { pattern: 'private' }), false);
  assert.equal(
    blocked('Read', { file_path: '/repo/run-reports/r1.json' }),
    false,
  );
  assert.equal(blocked('Bash', { command: 'cat run-reports/r1.json' }), false);
});

test('bash: secrets and private', () => {
  assert.equal(blocked('Bash', { command: 'cat .env' }), true);
  assert.equal(blocked('Bash', { command: 'cat --env-file=.env' }), true);
  assert.equal(blocked('Bash', { command: 'cat ".env"' }), true);
  assert.equal(blocked('Bash', { command: 'cat .env.example' }), false);
  assert.equal(blocked('Bash', { command: 'ls apps/private-api' }), false);
  for (const command of [
    'grep -r token ./private/',
    'cat private/applications.json',
    'jq .jobs private/applications.json',
    'pnpm nx run runner:answers-eval -- --set private',
    'cat private/applications.json | wc -l',
    'ls -la private/',
    'sed -i s/a/b/ private/fact-bank.yaml',
    'ls private/*',
    'cat private/*.json',
    'rm private/*.yaml',
    'echo private',
    'git commit -m "read private"',
  ]) {
    assert.equal(blocked('Bash', { command }), false, command);
  }
  for (const command of [
    'echo x > private/applications.json',
    'cat x > private/applications.json',
    'cat x >> private/applications.json',
    'cat a | tee private/applications.json',
    'sed -i s/a/b/ private/applications.json',
    'cp x private/applications.json',
    'mv x private/applications.json',
    'rm private/applications.json',
    'bash -c "echo > private/applications.json"',
    'sh -c "cat x > private/applications.json"',
    "python -c \"open('private/applications.json','w')\"",
    'cat private/applications.json --in-place',
    "echo 'unterminated > private/applications.json",
    'rm private/*',
    'rm -rf private/',
    'rm -rf ./private',
    'rm -rf apps/../private',
    'find private -delete',
    'rm private/app*.json',
    'mv private/applications.json?* /tmp',
  ]) {
    const r = evaluate({ tool_name: 'Bash', tool_input: { command } });
    assert.equal(r.block, true, command);
    assert.match(r.reason, /applications\.json is the author's to change/);
  }
});

test('bash: git push of a feature branch is allowed', () => {
  for (const command of [
    'git push -u origin chore/x',
    'git push --set-upstream origin docs/phase-2-roadmap',
    'git push origin feat/edit-preferences',
    'git push origin refs/heads/feat/x',
    'git -C .worktrees/x push -u origin feat/x',
    'cd .worktrees/x && git push -u origin feat/x',
    'git status && git push -u origin fix/a_b.c',
    'bash -c "git push -u origin chore/x"',
    // redirections are not refspecs
    'git push -u origin chore/x 2>&1 | tail -3',
    'git push -u origin chore/x > /tmp/log 2>&1',
    'git push origin chore/x 2>/dev/null',
    'git push origin chore/x >&2',
    'git push origin chore/x>>/tmp/log',
  ]) {
    assert.equal(blocked('Bash', { command }), false, command);
  }
});

test('bash: unsafe git push forms stay blocked', () => {
  for (const command of [
    // main, directly or by another name
    'git push origin main',
    '/usr/bin/git push origin main',
    'git push -u origin main',
    'git push origin refs/heads/main',
    'git push origin master',
    'git push origin HEAD',
    'git push origin feat/x:main',
    'git push origin HEAD:main',
    // implicit target
    'git push',
    'git push -u',
    'git push origin',
    // force, delete, mirror, all
    'git push --force origin feat/x',
    'git push -f origin feat/x',
    'git push -uf origin feat/x',
    'git push --force-with-lease origin feat/x',
    'git push origin +feat/x',
    'git push --delete origin feat/x',
    'git push -d origin feat/x',
    'git push origin :feat/x',
    'git push --mirror origin',
    'git push --all origin',
    'git push --tags origin',
    // other remotes, extra refspecs, tags, overrides, flags
    'git push upstream feat/x',
    'git push git@github.com:x/y.git feat/x',
    'git push origin feat/x main',
    'git push origin refs/tags/v1',
    'git push origin feat/../main',
    'git -c remote.origin.url=x push origin feat/x',
    'git --config-env=a=b push origin feat/x',
    'git push --no-verify origin feat/x',
    'git push --receive-pack=x origin feat/x',
    'git push -o ci.skip origin feat/x',
    // unverifiable arguments
    'echo main | xargs git push origin feat/x',
    'bash -c "git push origin main"',
    'git push origin main 2>&1 | tail -3',
    'git push origin feat/x 2>&1 main',
  ]) {
    assert.equal(blocked('Bash', { command }), true, command);
  }
});

test('bash: git push', () => {
  assert.equal(blocked('Bash', { command: 'git push' }), true);
  assert.equal(blocked('Bash', { command: 'cd apps && git push' }), true);
  assert.equal(blocked('Bash', { command: 'git -C apps push' }), true);
  assert.equal(
    blocked('Bash', { command: 'git status; git push --force' }),
    true,
  );
  assert.equal(blocked('Bash', { command: 'FOO=1 git push' }), true);
  assert.equal(blocked('Bash', { command: 'git commit -m "push fix"' }), false);
  assert.equal(blocked('Bash', { command: 'git status' }), false);
});

test('bash: separators attached to tokens', () => {
  for (const command of [
    'cat .env; ls',
    'cat .env|head',
    'cat <.env',
    'echo $(cat .env)',
    'echo `cat .env`',
  ]) {
    assert.equal(blocked('Bash', { command }), true, command);
  }
  assert.equal(blocked('Bash', { command: 'cat .env.example; ls' }), false);
  assert.equal(blocked('Bash', { command: 'bash -c "cat .env"' }), true);
  assert.equal(blocked('Bash', { command: 'cat private/x;ls' }), false);
  assert.equal(blocked('Bash', { command: "sh -c 'ls private/'" }), false);
  assert.equal(blocked('Bash', { command: 'eval cat .env' }), true);
  assert.equal(
    blocked('Bash', { command: 'bash -c "cat .env.example"' }),
    false,
  );
});

test('bash: git push through wrappers', () => {
  for (const command of [
    'sleep 1 & git push',
    '(git push)',
    '{ git push; }',
    '$(git push)',
    '`git push`',
    'sudo git push',
    'env git push',
    'env FOO=1 git push',
    'sudo -E git push',
    'time git push',
    'command git push',
    'nice -n 5 git push',
    'exec git push',
    'xargs git push',
    'bash -c "git push"',
    "sh -c 'cd x && git push'",
    'zsh -lc "git push"',
    'eval git push',
    'eval "git push"',
  ]) {
    assert.equal(blocked('Bash', { command }), true, command);
  }
  assert.equal(blocked('Bash', { command: 'bash -c "git status"' }), false);
  assert.equal(blocked('Bash', { command: 'sudo git status' }), false);
});

test('bash: comments, escapes, heredocs, unterminated quotes', () => {
  for (const command of [
    "# Let's push the branch\ngit push -u origin main",
    "# don't print it\ncat .env",
    "cat > /tmp/m <<'EOF'\nDon't forget\nEOF\ngit commit -F /tmp/m && git push",
    "echo it\\'s && git push",
    "echo 'unterminated && git push",
    "echo 'unterminated && cat .env",
  ]) {
    assert.equal(blocked('Bash', { command }), true, command);
  }
  for (const command of [
    'git commit -m "push fix"',
    'git commit -m "say \\"push\\" now"',
    '# git push later\nls',
    "cat > /tmp/m <<'EOF'\ngit push\nEOF\nls",
  ]) {
    assert.equal(blocked('Bash', { command }), false, command);
  }
});

test('bash: env wildcards', () => {
  for (const command of ['cat .env*', 'grep KEY .env*', 'cat .env{,.local}']) {
    assert.equal(blocked('Bash', { command }), true, command);
  }
  assert.equal(blocked('Bash', { command: 'cat .envrc' }), false);
  assert.equal(blocked('Bash', { command: 'cat .env.example' }), false);
  assert.equal(blocked('Bash', { command: 'ls *.ts' }), false);
});

test('bash: keywords and wrappers before git push', () => {
  for (const command of [
    'if true; then git push; fi',
    'for x in a; do git push; done',
    'if false; then :; else git push; fi',
    '! git push',
    'nohup git push',
    'timeout 60 git push',
    'timeout -s KILL 60 git push',
    'git \\\n push',
  ]) {
    assert.equal(blocked('Bash', { command }), true, command);
  }
  assert.equal(blocked('Bash', { command: 'timeout 60 git status' }), false);
});

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
    "gh pr edit 1 --base dev --title 'x",
    'gh pr review 12 --approve=true',
    'gh pr review 12 -a=true',
    'gh pr review 12 -ab ok',
    'gh pr create -B dev --title -Bmain',
    'gh pr create --base dev --title --base=main',
    'gh api -X PUT repos/o/r/pulls/1/merge --jq -XGET',
    '/home/linuxbrew/.linuxbrew/bin/gh pr merge 1',
    '$(which gh) pr merge 1',
    'GH=gh; $GH pr merge 1',
    'find . -exec gh pr merge 1 \\;',
    'gh pr merge$IFS1',
    "gh alias set mm 'pr merge'",
    'gh alias import aliases.yml',
    'gh extension install owner/gh-merge',
    'gh ext install owner/gh-merge',
    'gh extension exec merge',
    'gh api -H "X-HTTP-Method-Override: PUT" repos/o/r/pulls/1/merge',
  ]) {
    assert.equal(blocked('Bash', { command }), true, command);
  }
});

test('bash: gh reads and PRs to main are allowed', () => {
  for (const command of [
    'gh pr create --title x --body y',
    'gh pr create --base main --title x',
    'gh pr create -B main',
    'gh pr create -Bmain',
    'gh api -XGET repos/o/r/pulls',
    'gh pr view 12',
    'gh pr list',
    'gh pr edit 12 --title "new title"',
    'gh pr review 12 --comment -b "looks fine"',
    'gh api repos/o/r/pulls/1/comments',
    'gh api -X GET repos/o/r/pulls -f state=open',
    'gh api --method=GET repos/o/r/pulls',
    'git commit -m "gh pr merge later"',
    'gh pr list --state merged',
    'gh alias list',
    'gh extension list',
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
    'pnpm exec apps/fake-runner/bin.js apply x',
    'pnpm -w nx run fake-runner:apply',
    'pnpm --reporter silent nx run fake-runner:apply',
    'node node_modules/nx/bin/nx.js run fake-runner:apply',
    'node node_modules/nx/bin/nx run fake-runner:apply',
    'pnpm nx --output-style stream run-many -t apply',
    'pnpm nx -c production run-many -t apply',
    'pnpm nx apply',
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
    'pnpm exec apps/fake-runner/bin.js apply x --dry-run',
  ]) {
    assert.equal(runnerBlocked(command), false, command);
  }
});

test('runner: no name configured blocks nothing', () => {
  assert.equal(
    runnerBlocked('node apps/fake-runner/main.js apply x', {
      runnerName: '',
    }),
    false,
  );
  assert.equal(
    runnerBlocked('pnpm nx run-many -t apply', { runnerName: '' }),
    false,
  );
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

test('unrelated tools pass', () => {
  assert.equal(blocked('WebSearch', { query: '.env' }), false);
});

test('reasons', () => {
  const push = evaluate({
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
  });
  assert.match(push.reason, /name the remote and one branch/);
  const main = evaluate({
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
  });
  assert.match(main.reason, /main is protected/);
  const secret = evaluate({
    tool_name: 'Read',
    tool_input: { file_path: '/repo/.env' },
  });
  assert.match(secret.reason, /\/repo\/\.env/);
});

const bash = (command) =>
  evaluate({ tool_name: 'Bash', tool_input: { command } });

test('runner (real name): non-dry launches blocked', () => {
  for (const command of [
    'pnpm nx run runner:apply',
    'cd apps/runner && pnpm exec tsx src/main.ts apply x',
    'tsx apps/runner/src/main.ts apply x',
    'node apps/runner/src/main.ts apply x',
    'cd apps/runner && tsx src/main.ts apply https://example.com/job',
    'cd apps/runner && tsx --conditions=@xapply/source src/main.ts apply x',
    'tsx --conditions=@xapply/source apps/runner/src/main.ts apply x',
    'node dist/apps/runner/main.js apply x',
  ]) {
    const r = bash(command);
    assert.equal(r.block, true, command);
    assert.match(r.reason, /Runner blocked/, command);
  }
});

test('runner (real name): safe commands pass', () => {
  for (const command of [
    'pnpm nx run runner:session',
    'pnpm nx run runner:bot-check',
    'pnpm nx run runner:bot-check-repeat',
    'pnpm nx run runner:bridge-install',
    'pnpm nx run runner:bridge-check',
    'pnpm nx run runner:bridge-check-crash',
    'pnpm nx run runner:pace-record',
    'pnpm nx run runner:facts-check',
    'pnpm nx run runner:answers-eval',
    'pnpm nx run runner:disqualify-eval',
    'pnpm nx run runner:disqualify-eval -- --repeat 3 --model sonnet',
    'pnpm nx run runner:snapshot -- https://www.linkedin.com/jobs/view/1/',
    'pnpm nx run runner:snapshot-scrub',
    'pnpm nx run runner:apply -- https://www.linkedin.com/jobs/view/1/ --dry-run',
    'tsx apps/runner/src/main.ts answers eval --set example --repeat 3',
    'tsx apps/runner/src/main.ts facts check',
    'tsx --conditions=@xapply/source apps/runner/src/main.ts facts check',
    'cd apps/runner && tsx --conditions=@xapply/source src/main.ts bridge check',
    'cd apps/runner && tsx --conditions=@xapply/source src/main.ts apply x --dry-run',
    'tsx apps/runner/src/main.ts pace compare',
    'tsx apps/runner/src/main.ts bridge check',
    'pnpm nx run runner:apply --dry-run',
  ]) {
    assert.equal(bash(command).block, false, command);
  }
});

test('runner (real name): apply without dry-run is blocked', () => {
  const r = bash(
    'pnpm nx run runner:apply -- https://www.linkedin.com/jobs/view/1/',
  );
  assert.equal(r.block, true);
  assert.match(r.reason, /Runner blocked/);
});

test('runner (real name): no false positives', () => {
  for (const command of [
    'ls apps/runner',
    'cat apps/runner/src/main.ts',
    'pnpm nx test runner',
    'pnpm nx lint runner',
    'pnpm nx run-many -t lint test build typecheck',
    'pnpm nx affected -t test',
    'grep -rn runner docs',
    'echo "test runner"',
    'git commit -m "runner: add relay"',
    'pnpm vitest run --reporter verbose',
  ]) {
    assert.equal(bash(command).block, false, command);
  }
});

test('bash: runner false positives', () => {
  for (const command of [
    'ls apps/runner/src',
    "for f in run-reports/*.json; do node -e 'console.log(1)' $f; done; ls apps/runner/src",
    'cat pace-recordings/runner/x.json',
    'node scripts/x.mjs pace-recordings/runner/a.json',
  ]) {
    assert.equal(bash(command).block, false, command);
  }
  for (const command of [
    'node apps/runner/dist/main.js apply https://x',
    'node dist/apps/runner/main.js apply https://x',
    'node -e "require(\'./apps/runner/dist/main.js\')" apply x',
    'node --eval "require(\'./apps/runner/dist/main.js\')" apply x',
    'node -p "require(\'./apps/runner/dist/main.js\')"',
  ]) {
    const r = bash(command);
    assert.equal(r.block, true, command);
    assert.match(r.reason, /Runner blocked/, command);
  }
  assert.equal(
    bash('node -e "require(\'./apps/runner/dist/main.js\')" x apply --dry-run')
      .block,
    false,
  );
});
