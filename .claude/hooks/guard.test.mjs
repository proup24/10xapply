import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  evaluate,
  readSupabaseProjectRef,
  remoteOptInProblem,
  supabaseCliProblem,
  sqlProblem,
  supabaseToolProblem,
  SUPABASE_NO_PROJECT_TOOLS,
  SUPABASE_REF_TOOLS,
} from './guard.mjs';

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
    'node --print="require(\'./apps/runner/dist/main.js\')" apply x',
    // after the script, eval flags are the script's own arguments
    'node apps/runner/dist/main.js apply https://x -p',
    'node apps/runner/dist/main.js apply https://x -e',
    'node apps/runner/dist/main.js apply https://x --eval=1',
    'node apps/runner/dist/main.js apply https://x --print 1',
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

const REF = 'abcdefghijklmnopqrst';
const mcp = (suffix, input, ref = REF) =>
  evaluate(
    {
      tool_name: `mcp__plugin_supabase_supabase__${suffix}`,
      tool_input: input,
    },
    { supabaseProjectRef: ref },
  ).block;

test('supabase: allowed tools on the committed project', () => {
  assert.equal(mcp('list_tables', { project_id: REF }), false);
  assert.equal(mcp('get_project', { id: REF }), false);
  assert.equal(
    mcp('execute_sql', {
      project_id: REF,
      query: 'select * from public.users',
    }),
    false,
  );
  assert.equal(mcp('list_projects', {}), false);
  assert.equal(mcp('search_docs', { graphql_query: '{x}' }), false);
});
test('supabase: other projects and no ref are refused', () => {
  assert.equal(
    mcp('list_tables', { project_id: 'zzzzzzzzzzzzzzzzzzzz' }),
    true,
  );
  assert.equal(mcp('get_project', { id: 'zzzzzzzzzzzzzzzzzzzz' }), true);
  assert.equal(mcp('list_tables', {}), true);
  assert.equal(mcp('list_tables', { project_id: REF }, null), true);
});
test('supabase: tools off the allowlist are refused', () => {
  for (const t of [
    'apply_migration',
    'create_project',
    'pause_project',
    'restore_project',
    'create_branch',
    'delete_branch',
    'merge_branch',
    'rebase_branch',
    'reset_branch',
    'deploy_edge_function',
    'create_edge_function_secret',
    'create_notebook',
    'run_notebook',
    'submit_feedback',
    'delete_feedback',
    'some_future_tool',
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
  ])
    assert.equal(mcp(t, { project_id: REF }), true, t);
});
test('supabase: prototype names are not allowlisted', () => {
  for (const t of ['constructor', 'toString', 'hasOwnProperty']) {
    const input = { [String(Object.prototype[t])]: REF, project_id: REF };
    assert.equal(mcp(t, input), true, t);
  }
});
test('supabase: any server name with supabase is checked', () => {
  assert.equal(
    evaluate(
      {
        tool_name: 'mcp__claude_ai_Supabase__apply_migration',
        tool_input: { project_id: REF },
      },
      { supabaseProjectRef: REF },
    ).block,
    true,
  );
});
test('supabase sql: reads and public writes pass', () => {
  for (const q of [
    'select 1',
    '  SELECT id FROM public.users;',
    '-- look\nselect 1',
    'update public.users set "updatedAt" = now() where id = \'00000000-0000-0000-0000-000000000000\'',
    'with x as (select 1) select * from x',
    'select * from auth.users',
    'select * from supabase_migrations.schema_migrations',
  ])
    assert.equal(sqlProblem(q), null, q);
});
test('supabase sql: schema changes, many statements and system writes are refused', () => {
  for (const q of [
    'create table public.x (id int)',
    'ALTER TABLE public.users DISABLE ROW LEVEL SECURITY',
    'drop table public.users',
    'truncate public.users',
    'grant all on public.users to anon',
    'select 1; drop table public.users',
    'select 1 -- x\n; select 2',
    'do $$ begin end $$',
    "insert into auth.users (id) values ('x')",
    'delete from storage.objects',
    'update supabase_migrations.schema_migrations set version = 1',
    'with d as (delete from auth.users returning id) select * from d',
    'copy public.users to stdout',
    'set role postgres',
  ])
    assert.notEqual(sqlProblem(q), null, q);
});

// Review-focus spellings and fail-closed edges beyond the brief.
test('supabase sql: trailing semicolon and comment spellings', () => {
  assert.equal(sqlProblem('select 1;'), null);
  assert.equal(sqlProblem('/* c */ select 1'), null);
  assert.equal(sqlProblem('select 1; '), null);
  assert.equal(sqlProblem('select 1;\n\t '), null);
  assert.equal(sqlProblem('select 1; -- done'), null);
  assert.equal(sqlProblem("select 'a--b' from public.users"), null);
  assert.notEqual(sqlProblem('select 1;;'), null);
  assert.notEqual(sqlProblem('select 1 ; ;'), null);
  assert.notEqual(sqlProblem(';select 1'), null);
});
test('supabase sql: first word', () => {
  for (const q of [
    '',
    '   ',
    '-- only a comment',
    'vacuum',
    'explain analyze delete from public.users',
    'merge into public.users using x on true when matched then delete',
    'lock table public.users',
    'notify x',
    'prepare p as select 1',
    'begin',
    '(select 1)',
    'selectx 1',
    'refresh materialized view public.v',
    'reset all',
  ])
    assert.notEqual(sqlProblem(q), null, JSON.stringify(q));
});
test('supabase sql: keywords as whole words, in strings and comments too', () => {
  for (const q of [
    "select * from public.x where y = 'drop'",
    '-- create\nselect 1',
    'select 1 /* revoke */',
    "select set_config('a', 'b', false) from x comment",
    'with x as (select 1) select * from x security',
    'select 1 from x do',
    'select call from x',
    'select 1 from x where reset   role',
    'select 1 from x where SET\nSESSION',
    'select 1 from x where set/**/role',
  ])
    assert.notEqual(sqlProblem(q), null, q);
  for (const q of [
    'select created_at, dropped, "doSomething" from public.users',
    "select id from public.users where kind = 'creator'",
    'select settings from public.users',
  ])
    assert.equal(sqlProblem(q), null, q);
});
test('supabase sql: system schema writes, ledger included', () => {
  for (const q of [
    "insert into prisma_contract._prisma_migrations (id) values ('x')",
    'update extensions.x set a = 1',
    'delete from pg_catalog.pg_class',
    'update information_schema.x set a = 1',
    'update "auth"."users" set email = \'x\'',
    "update AUTH.users set email = 'x'",
    "update auth . users set email = 'x'",
    'insert into public.x select * from pg_authid',
    'update U&"\\0061uth".users set email = \'x\'',
    "with d as (update auth.users set email = 'x' returning id) select 1",
  ])
    assert.notEqual(sqlProblem(q), null, q);
  assert.equal(
    sqlProblem('select * from prisma_contract._prisma_migrations'),
    null,
  );
  assert.equal(sqlProblem('select * from pg_catalog.pg_class'), null);
});
test('supabase sql: dollar quoting is refused', () => {
  for (const q of [
    'select $$x$$',
    'select $tag$x$tag$',
    'select $_a1$x$_a1$',
    '-- $$\nselect 1',
  ])
    assert.notEqual(sqlProblem(q), null, q);
});
test('supabase sql: comments cannot hide code', () => {
  for (const q of [
    // Postgres nests block comments; the scanner must too.
    '/* /* */ select 1 */ vacuum',
    '/* unterminated select 1',
    // A line comment ends at \r as well as \n.
    '-- x\rvacuum\nselect 1',
    // An E-string escape must not turn code into a "comment".
    "select E'\\' -- ' into public.y from public.x",
    "select E'\\' -- '; vacuum",
  ])
    assert.notEqual(sqlProblem(q), null, JSON.stringify(q));
});
test('supabase sql: select into creates a table and is refused', () => {
  assert.notEqual(sqlProblem('select * into public.y from public.x'), null);
  assert.notEqual(sqlProblem('select * into auth.y from auth.users'), null);
  assert.equal(sqlProblem("insert into public.users (id) values ('x')"), null);
  assert.equal(
    sqlProblem("INSERT\n  INTO public.users (id) values ('x')"),
    null,
  );
});
test('supabase: execute_sql text is checked through evaluate', () => {
  assert.equal(
    mcp('execute_sql', { project_id: REF, query: 'drop table public.users' }),
    true,
  );
  assert.equal(mcp('execute_sql', { project_id: REF }), true);
  assert.equal(mcp('execute_sql', { project_id: REF, query: 7 }), true);
  const r = evaluate(
    {
      tool_name: 'mcp__plugin_supabase_supabase__execute_sql',
      tool_input: { project_id: REF, query: 'drop table x' },
    },
    { supabaseProjectRef: REF },
  );
  assert.match(
    r.reason,
    /^Supabase blocked: .+\. Claude may read and write rows in 10xapply's project only; the schema changes only through CI \(see CLAUDE\.md\)\.$/,
  );
});
test('supabase: every ref tool needs its own argument to equal the ref', () => {
  for (const [suffix, arg] of Object.entries(SUPABASE_REF_TOOLS)) {
    const input = { [arg]: REF };
    if (suffix === 'execute_sql') input.query = 'select 1';
    assert.equal(mcp(suffix, input), false, suffix);
    assert.equal(mcp(suffix, { ...input, [arg]: REF.toUpperCase() }), true);
    assert.equal(mcp(suffix, { ...input, [arg]: undefined }), true, suffix);
    assert.equal(mcp(suffix, input, null), true, suffix);
    assert.equal(mcp(suffix, input, ''), true, suffix);
  }
  assert.equal(mcp('get_project', { project_id: REF }), true);
  for (const suffix of SUPABASE_NO_PROJECT_TOOLS)
    assert.equal(mcp(suffix, {}, null), false, suffix);
});
test('supabase: odd inputs and names fail closed', () => {
  assert.equal(
    evaluate(
      { tool_name: 'mcp__plugin_supabase_supabase__list_tables' },
      { supabaseProjectRef: REF },
    ).block,
    true,
  );
  assert.notEqual(supabaseToolProblem('mcp__supabase', {}, REF), null);
  assert.equal(supabaseToolProblem('mcp__context7__query-docs', {}, REF), null);
  assert.equal(supabaseToolProblem('Bash', {}, REF), null);
  assert.equal(
    evaluate(
      { tool_name: 'mcp__context7__query-docs', tool_input: { query: 'x' } },
      { supabaseProjectRef: REF },
    ).block,
    false,
  );
  assert.equal(
    evaluate(
      {
        tool_name: 'mcp__SUPABASE__list_tables',
        tool_input: { project_id: 'zzzzzzzzzzzzzzzzzzzz' },
      },
      { supabaseProjectRef: REF },
    ).block,
    true,
  );
});
test('supabase: the ref file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ref-'));
  const url = (name) => pathToFileURL(join(dir, name));
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ projectRef: REF }));
  writeFileSync(join(dir, 'null.json'), '{ "projectRef": null }');
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  writeFileSync(join(dir, 'num.json'), '{ "projectRef": 7 }');
  writeFileSync(join(dir, 'arr.json'), '[1]');
  assert.equal(readSupabaseProjectRef(url('ok.json')), REF);
  assert.equal(readSupabaseProjectRef(url('null.json')), null);
  assert.equal(readSupabaseProjectRef(url('bad.json')), null);
  assert.equal(readSupabaseProjectRef(url('num.json')), null);
  assert.equal(readSupabaseProjectRef(url('arr.json')), null);
  assert.equal(readSupabaseProjectRef(url('missing.json')), null);
  // Not passed: the committed file next to the hooks, which holds null.
  // Not passed: the committed file next to the hooks. It holds null until
  // the author commits the real ref, so accept either.
  const committed = readSupabaseProjectRef();
  assert.ok(
    committed === null || /^[a-z0-9]{20}$/.test(committed),
    'committed ref is null or a project ref',
  );
  assert.equal(
    evaluate({
      tool_name: 'mcp__plugin_supabase_supabase__list_tables',
      tool_input: { project_id: REF },
    }).block,
    true,
  );
  assert.equal(
    evaluate({
      tool_name: 'mcp__plugin_supabase_supabase__list_projects',
      tool_input: {},
    }).block,
    false,
  );
});

// Review fixes: write targets, side-effect functions, upserts.
test('supabase sql: writes reach only public tables', () => {
  for (const q of [
    "insert into vault.secrets (secret) values ('x')",
    'delete from realtime.messages',
    "insert into net.http_request_queue (url) values ('x')",
    'delete from supabase_functions.hooks',
    'update graphql_public.x set a = 1',
    "insert into cron.job (schedule, command) values ('* * * * *', chr(100)||'rop table public.users')",
    'insert into "cron"."job" (command) values (\'x\')',
    'update only cron.job set a = 1',
    'delete from only cron.job',
    'update cron . job set a = 1',
    'update cron/**/.job set a = 1',
    'update "Public".users set a = 1',
    'update mydb.public.users set a = 1',
    "with d as (insert into cron.job (command) values ('x') returning 1) select * from d",
    'with d as (delete from realtime.messages returning 1) select 1',
    // A write keyword the check cannot read is refused.
    'insert public.users values (1)',
    "select * from public.x where y = 'update'",
  ])
    assert.notEqual(sqlProblem(q), null, q);
  for (const q of [
    'update public.users set "updatedAt" = now() where id = \'00000000-0000-0000-0000-000000000000\'',
    "insert into users (id) values ('x')",
    'delete from "public"."users" where id = \'x\'',
    "delete from only public.users where id = 'x'",
    'UPDATE PUBLIC.users set a = 1',
    "insert into public . users (id) values ('x')",
    'with d as (delete from public.users returning id) select * from d',
    'select * from auth.users',
    'select * from public.users for update',
    'select * from public.users for no key update',
  ])
    assert.equal(sqlProblem(q), null, q);
});
test('supabase sql: side-effect functions are refused', () => {
  for (const q of [
    "select cron.schedule('j','* * * * *', 'x')",
    "select dblink_exec('x','y')",
    "select dblink('x','y')",
    "select vault.create_secret('x')",
    'select pgsodium.create_key()',
    "select set_config('role','service_role',false)",
    "select SET_CONFIG ('role','service_role',false)",
    "select \"set_config\"('a','b',false)",
    "select lo_import('/etc/passwd')",
    "select pg_read_file('x')",
    "select pg_read_binary_file('x')",
    "select pg_ls_dir('.')",
    "select pg_stat_file('x')",
    'select pg_terminate_backend(pid) from pg_stat_activity',
    'select pg_cancel_backend(1)',
    'select pg_sleep(10)',
    "select pg_sleep_for('1 s')",
    'select pg_reload_conf()',
    'select pg_rotate_logfile()',
    'select pg_advisory_lock(1)',
    "select pg_notify('a','b')",
    "select \"cron\".\"schedule\"('a','b','c')",
    "select cron . schedule ('a','b','c')",
    "select cron/**/.schedule('a','b','c')",
    'select public.f()',
    'select x.auth.uid()',
    "update public.users set a = cron.schedule('a','b','c')",
    "insert into public.users (id) select pg_read_file('x')",
  ])
    assert.notEqual(sqlProblem(q), null, q);
  for (const q of [
    'select count(*) from public.users',
    'select now()',
    'select gen_random_uuid()',
    'select auth.uid()',
    'select auth.jwt()',
    'select AUTH.UID()',
    'select "auth"."uid"()',
    'select coalesce(a, b) from public.users',
    'select u.id from public.users u where u.id = auth.uid()',
    "insert into public.users (id) values ('x')",
    'insert into "public"."users" (id) values (\'x\')',
  ])
    assert.equal(sqlProblem(q), null, q);
});
test('supabase sql: upserts pass, a DO statement does not', () => {
  for (const q of [
    "insert into public.users (id) values ('x') on conflict (id) do nothing",
    'insert into public.users (id) values (\'x\') on conflict (id) do update set "updatedAt" = now()',
    "INSERT INTO users (id) VALUES ('x') ON CONFLICT DO NOTHING;",
  ])
    assert.equal(sqlProblem(q), null, q);
  for (const q of [
    'do $$ begin end $$',
    "do 'begin end'",
    "DO language plpgsql 'begin end'",
    '/* x */ do nothing',
    'select 1 from x do',
    "insert into public.users (id) values ('x') on conflict (id) do 'x'",
    "insert into public.users (id) values ('x') on conflict (id) do update set role = 'x'",
  ])
    assert.notEqual(sqlProblem(q), null, q);
});

test('supabase cli: local commands pass', () => {
  for (const c of [
    'supabase start',
    'pnpm exec supabase status -o env',
    'supabase stop --no-backup',
    'pnpm exec supabase gen types typescript --local --schema public',
    'supabase gen signing-key --algorithm ES256 --append',
    'supabase db reset',
    'supabase migration list --local',
    'supabase --help',
    'pnpm db:start',
    'pnpm db:types',
  ])
    assert.equal(blocked('Bash', { command: c }), false, c);
});
test('supabase cli: remote and account commands are refused', () => {
  for (const c of [
    'supabase link --project-ref abc',
    'supabase db push',
    'pnpm exec supabase db push',
    'npx supabase link',
    'supabase --workdir x link',
    'supabase projects list',
    'supabase projects delete abc',
    'supabase login',
    'supabase secrets set A=b',
    'supabase functions deploy x',
    'supabase db pull',
    'supabase db dump',
    'supabase migration repair 1 --status applied',
    'supabase branches list',
    'supabase gen types typescript --project-id abc',
    'supabase gen types typescript --linked',
    'supabase db reset --linked',
    'supabase db reset --db-url postgresql://u:p@h/db',
    'bash -c "supabase db push"',
    'ls && supabase link',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
});
test('remote db opt-in is refused', () => {
  for (const c of [
    'XAPPLY_ALLOW_REMOTE_DB=1 pnpm db:migrate',
    'env XAPPLY_ALLOW_REMOTE_DB=1 pnpm db:seed',
    'export XAPPLY_ALLOW_REMOTE_DB=1; pnpm db:migrate',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
  assert.equal(blocked('Bash', { command: 'pnpm db:migrate' }), false);
});

test('supabase cli: other launch forms and the repo scripts', () => {
  for (const c of [
    'pnpm exec supabase start -x studio,realtime,edge-runtime,imgproxy,logflare,vector',
    '/home/linuxbrew/.linuxbrew/bin/supabase start',
    'node_modules/.bin/supabase status -o env',
    './node_modules/.bin/supabase stop --no-backup',
    'supabase gen types typescript --local --schema public',
    'supabase -o env status',
    'supabase --version',
    'supabase',
    'supabase db reset --local',
    'npx supabase start',
    'yarn supabase status',
    'npm exec supabase -- status',
    'pnpm dlx supabase@2.40.7 start',
    'eval "$(scripts/supabase-env.sh)"',
    'scripts/supabase-env.sh',
    'ls supabase',
    'cat supabase/config.toml',
    'git add supabase/config.toml',
    'pnpm add -D supabase',
    ...['stop', 'status', 'reset', 'migrate', 'seed', 'test'].map(
      (s) => `pnpm db:${s}`,
    ),
  ])
    assert.equal(blocked('Bash', { command: c }), false, c);
  for (const c of [
    'supabase link --help',
    'supabase db push -h',
    '/home/linuxbrew/.linuxbrew/bin/supabase link --project-ref abc',
    'node_modules/.bin/supabase db push',
    './node_modules/.bin/supabase login',
    'pnpm dlx supabase db push',
    'npm exec supabase -- db push',
    'yarn supabase link',
    'npx supabase@latest projects list',
    'pnpm exec supabase db reset --linked',
    'supabase migration list',
    'supabase migration list --linked',
    'supabase migration list --local --db-url postgresql://h/db',
    'supabase status --project-ref abc',
    'supabase start --db-url=postgresql://h/db',
    'supabase db reset --password x',
    'supabase db reset -p x',
    'supabase db reset --linked=true',
    'supabase gen bearer-jwt',
    'supabase gen',
    'supabase inspect db locks',
    'supabase db diff',
    'supabase migration up',
    'supabase seed buckets',
    'supabase test db',
    'supabase --profile x link',
    'sudo supabase link',
    'timeout 5 supabase db push',
    'sh -c "pnpm exec supabase db push"',
    'eval "supabase link"',
    'echo hi; supabase db push',
    'find . -exec supabase link \;',
    "supabase db push 'unclosed",
    "echo 'x && supabase start",
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
});

test('remote db opt-in: hidden forms are refused', () => {
  for (const c of [
    'bash -c "XAPPLY_ALLOW_REMOTE_DB=1 pnpm db:migrate"',
    "bash -c 'export XAPPLY_ALLOW_REMOTE_DB=1; pnpm db:migrate'",
    'export XAPPLY_ALLOW_REMOTE_DB=1',
    'export "XAPPLY_ALLOW_REMOTE_DB=1"',
    'XAPPLY_ALLOW_REMOTE_DB= pnpm db:migrate',
    'export XAPPLY_ALLOW_REMOTE_DB+=1',
    "echo 'x; XAPPLY_ALLOW_REMOTE_DB=1 pnpm db:migrate",
    'MY_XAPPLY_ALLOW_REMOTE_DB_NOTE=1 true',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
  for (const c of [
    'XAPPLY_SKIP_ENV_FILES=1 pnpm db:migrate',
    'grep -r XAPPLY_ALLOW_REMOTE_DB libs',
  ])
    assert.equal(blocked('Bash', { command: c }), false, c);
  const { reason } = evaluate({
    tool_name: 'Bash',
    tool_input: { command: 'export XAPPLY_ALLOW_REMOTE_DB=1' },
  });
  assert.equal(
    reason,
    'Remote database blocked: only CI sets XAPPLY_ALLOW_REMOTE_DB.',
  );
});

test('supabase cli: the reason names the problem', () => {
  const { reason } = evaluate({
    tool_name: 'Bash',
    tool_input: { command: 'supabase db push' },
  });
  assert.match(
    reason,
    /^Supabase CLI blocked: .+\. Claude may run the local stack only \(see CLAUDE\.md\)\.$/,
  );
});

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

test('supabase cli review C1: -h cannot skip the checks', () => {
  for (const c of [
    'supabase projects delete abc --network-id -h --yes',
    'supabase db push --linked --network-id -h',
    'supabase --network-id -h db push --db-url postgresql://x',
    'supabase db reset --network-id -h --linked',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
});

test('supabase cli review C2: the positional words must match exactly', () => {
  for (const c of [
    'supabase --yes --network-id start projects delete abc',
    'supabase --network-id stop orgs create foo',
    'supabase --network-id status projects create x --org-id o --db-password pw --region eu-west-1',
    'supabase --network-id start secrets set A=b',
    'supabase start extra',
    'supabase gen types typescript extra --local',
    'supabase gen types rust --local',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
  for (const c of [
    'supabase start -x studio,realtime,edge-runtime,imgproxy,logflare,vector',
    'supabase status -o env',
    'supabase stop --no-backup',
    'supabase --network-id net start',
    'supabase --dns-resolver https start',
    'supabase --unknown=value start',
    'supabase --unknown start',
    'supabase gen types --local --schema public',
    'supabase gen types typescript -s public --local',
    'supabase gen types go --local',
    'supabase gen signing-key --algorithm ES256',
  ])
    assert.equal(blocked('Bash', { command: c }), false, c);
});

test('supabase cli review I1: every position and nested strings', () => {
  for (const c of [
    'setsid supabase db reset --linked',
    'setsid supabase migration repair 1 --status applied',
    "script -c 'supabase db push'",
    "npx -c 'supabase link'",
    "npm exec -c 'supabase link'",
    "pnpm exec bash -c 'supabase link'",
    "env -S 'supabase link'",
    'echo link | xargs supabase',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
  for (const c of [
    'ls supabase',
    'pnpm add -D supabase',
    'cat supabase/config.toml',
    'grep -rn supabase libs',
    "grep 'supabase link' docs",
    'git log --oneline -- supabase',
  ])
    assert.equal(blocked('Bash', { command: c }), false, c);
});

test('supabase cli review I2: backslash-newline joins the word', () => {
  assert.equal(blocked('Bash', { command: 'supa\\\nbase link' }), true);
  assert.equal(blocked('Bash', { command: '"supa\\\nbase" link' }), true);
  assert.equal(
    blocked('Bash', {
      command: 'XAPPLY_ALLOW_\\\nREMOTE_DB=1 pnpm db:migrate',
    }),
    true,
  );
  assert.equal(
    blocked('Bash', {
      command: 'XAPPLY_ALLOW_REMOTE_DB\\\n=1 pnpm db:migrate',
    }),
    true,
  );
  assert.equal(blocked('Bash', { command: 'supabase \\\n  start' }), false);
  assert.equal(
    blocked('Bash', { command: 'git push \\\n  -u origin feature-x' }),
    false,
  );
});

test('supabase cli review I3: the opt-in text outside read-only commands', () => {
  for (const c of [
    'env XAPPLY_ALLOW_REMOTE_DB${E}=1 pnpm db:migrate',
    "XAPPLY_ALLOW_REMOTE_D$'B'=1 pnpm db:migrate",
    "XAPPLY_ALLOW_REM$'OTE'_DB=1 pnpm db:migrate",
    'printf -v XAPPLY_ALLOW_REMOTE_DB 1; export XAPPLY_ALLOW_REMOTE_DB; pnpm db:migrate',
    'read XAPPLY_ALLOW_REMOTE_DB <<< 1; export XAPPLY_ALLOW_REMOTE_DB',
    'V=XAPPLY_ALLOW_REMOTE_DB; export "$V=1"',
    'grep ALLOW_REMOTE x > .envrc',
    'XAPPLY_ALLOW_REMOTE_DB=1 cat x',
    'sed -i s/x/ALLOW_REMOTE/ f',
    'git -c core.pager=x log ALLOW_REMOTE',
    'grep ALLOW_REMOTE x | bash',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
  for (const c of [
    'grep -rn ALLOW_REMOTE libs/database',
    'rg ALLOW_REMOTE .github 2>/dev/null | head -5',
    'git diff -- libs | grep ALLOW_REMOTE',
    'git log -S ALLOW_REMOTE --oneline',
    "sed -n '/ALLOW_REMOTE/p' libs/database/package.json",
  ])
    assert.equal(blocked('Bash', { command: c }), false, c);
});

test('supabase cli review minors', () => {
  for (const c of [
    'supabase stop --all',
    'supabase --workdir /tmp/other start',
    'supabase --workdir=../10xjobs start',
    'supabase --workdir ../10xjobs start',
    `supabase --workdir ${repoRoot}/../10xjobs start`,
    'supabase gen types typescript --schema public',
    'SUPABASE_PROJECT_ID=abc supabase start',
    'env SUPABASE_DB_PASSWORD=x supabase db reset',
    'SUPABASE_ACCESS_TOKEN=x pnpm exec supabase status',
    'echo $(supabase link)',
    'echo `supabase link`',
    'cat <(supabase db dump)',
    'S=supabase; $S link',
    "bash <<< 'supabase link'",
    'echo supabase link | bash',
    'echo supabase link | sh',
    'printf "supabase link" | zsh',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
  for (const c of [
    'supabase --workdir . start',
    'supabase --workdir ./ start',
    `supabase --workdir ${repoRoot} start`,
    `supabase --workdir=${repoRoot}/supabase status`,
    'eval "$(scripts/supabase-env.sh)"',
    'echo "$(cat supabase/config.toml)"',
    'SUPABASE_URL=x supabase status',
    'bash scripts/supabase-env.sh',
  ])
    assert.equal(blocked('Bash', { command: c }), false, c);
});

test('supabase cli: the exported checks', () => {
  assert.equal(supabaseCliProblem('supabase start'), null);
  assert.notEqual(supabaseCliProblem('supabase link'), null);
  assert.equal(remoteOptInProblem('pnpm db:migrate'), null);
  assert.notEqual(
    remoteOptInProblem('XAPPLY_ALLOW_REMOTE_DB=1 pnpm db:migrate'),
    null,
  );
});
