import { pathToFileURL } from 'node:url';

const segments = (p) => p.split('/');
// `/usr/bin/git` runs git: compare command words by their last segment.
const basename = (t) => t.split('/').at(-1);
const isSecret = (s) =>
  s === '.env' || (s.startsWith('.env.') && s !== '.env.example');

const pathHit = (p) => segments(p).some(isSecret);
// Globs can match a secret through a wildcard such as `.env*`.
const globHit = (p) =>
  segments(p).some((s) => s.startsWith('.env') && s !== '.env.example');

// Bash expands wildcards itself, so `.env*` must count as a secret too.
const bashHit = (t) =>
  pathHit(t) ||
  segments(t).some((s) => s.startsWith('.env') && /[*?[{]/.test(s));

// The applied-jobs record in the private folder is the runner's and the
// author's: Claude may read it but never change it. The runner's temporary
// copies (`applications.json.tmp`) count too.
export const PROTECTED_RECORD = 'applications.json';
// Commands that only read the files they name.
export const READ_ONLY_TOOLS = [
  'cat',
  'head',
  'tail',
  'less',
  'jq',
  'grep',
  'rg',
  'ugrep',
  'wc',
  'diff',
  'ls',
  'stat',
  'file',
  'sha256sum',
];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const RECORD_REASON = "applications.json is the author's to change";
const isRecord = (p) =>
  basename(p).startsWith(PROTECTED_RECORD) && segments(p).includes('private');
const blockRecord = () => ({
  block: true,
  reason: `Blocked: ${RECORD_REASON}. Claude may read it but never write it (see CLAUDE.md).`,
});

const PATH_KEYS = ['file_path', 'notebook_path'];
const CHECKS = {
  Grep: [
    [['path'], pathHit],
    [['glob'], globHit],
  ],
  Glob: [
    [['path'], pathHit],
    [['pattern'], globHit],
  ],
};

const blockPath = (p) => ({
  block: true,
  reason: `Blocked: ${p} is a secret file (see CLAUDE.md).`,
});

// Marks a redirection in a segment; the token after it is its target.
const REDIRECT = '\0redirect';

// Splits a command into segments of tokens. Unquoted shell operators and
// grouping characters end a token; `;`, `&`, `|`, newlines, parentheses and
// backticks also end the segment. Quote characters are removed, backslashes
// escape the next character (outside quotes and inside "..."), `#` starts a
// comment and heredoc bodies are skipped. `unclosed` is true when a quote is
// still open at the end, so the caller can fail closed.
function parse(command) {
  const segments = [[]];
  const heredocs = [];
  let token = '';
  let quote = null;
  const endToken = () => {
    if (token) segments.at(-1).push(token.replace(/^\.\//, ''));
    token = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        token += command[++i];
      } else token += ch;
    } else if (ch === '\\') {
      if (command[i + 1] === '\n') endToken();
      else token += command[i + 1] ?? '';
      i++;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && !token) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (ch === '<' && /^<<(?!<)/.test(command.slice(i))) {
      const m = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(command.slice(i));
      if (m) {
        heredocs.push({ word: m[3], strip: m[1] === '-' });
        i += m[0].length - 1;
      } else i++;
      endToken();
    } else if (ch === '\n') {
      endToken();
      segments.push([]);
      for (const { word, strip } of heredocs.splice(0)) {
        // skip body lines up to and including the delimiter line
        while (i + 1 < command.length) {
          const end = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, end < 0 ? command.length : end);
          i = end < 0 ? command.length : end;
          if ((strip ? line.trim() : line) === word) break;
        }
      }
    } else if (ch === '<' || ch === '>') {
      // `2>` names a file descriptor, not an argument.
      if (/^\d+$/.test(token)) token = '';
      else endToken();
      while (command[i + 1] === '<' || command[i + 1] === '>') i++;
      if (command[i + 1] === '&') i++;
      if (command[i] === '&' && /[\d-]/.test(command[i + 1] ?? '')) {
        // `>&2`, `2>&1`, `>&-` duplicate a descriptor: there is no target.
        while (/[\d-]/.test(command[i + 1] ?? '')) i++;
      } else segments.at(-1).push(REDIRECT);
    } else if (/[;&|()`]/.test(ch)) {
      endToken();
      segments.push([]);
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token += ch;
    }
  }
  endToken();
  return { segments, unclosed: quote !== null };
}

const WRAPPERS = ['sudo', 'env', 'time', 'command', 'nice', 'exec', 'xargs'];
// Shell keywords and wrappers that precede the real command word.
const KEYWORDS = [
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
];
const SHELLS = ['bash', 'sh', 'zsh'];

// Index of the command word, after grouping, VAR=value and wrapper commands.
function commandIndex(tokens) {
  let i = 0;
  for (;;) {
    const t = tokens[i];
    if (KEYWORDS.includes(t) || t === 'nohup' || /^\w+=/.test(t ?? '')) i++;
    else if (t === 'timeout') {
      i++;
      while (tokens[i]?.startsWith('-')) {
        i += tokens[i] === '-k' || tokens[i] === '-s' ? 2 : 1;
      }
      i++; // the duration
    } else if (WRAPPERS.includes(t)) {
      i++;
      // wrapper flags; `-n` (nice) and `-u` (env) take a value
      while (tokens[i]?.startsWith('-') || /^\w+=/.test(tokens[i] ?? '')) {
        i += tokens[i] === '-n' || tokens[i] === '-u' ? 2 : 1;
      }
    } else return i;
  }
}

// The command string run by `bash -c "..."`, `sh -c`, `zsh -c` or `eval`.
function nestedCommand(tokens, i) {
  if (SHELLS.includes(tokens[i])) {
    const c = tokens.findIndex((t, j) => j > i && /^-\w*c$/.test(t));
    return c >= 0 ? tokens[c + 1] : undefined;
  }
  if (tokens[i] === 'eval') return tokens.slice(i + 1).join(' ');
}

// Fallback for commands we could not tokenize (an unterminated quote).
const rawTokens = (command) =>
  command.split(/[\s;&|()`'"<>=]+/).map((t) => t.replace(/^\.\//, ''));

// Claude may push a feature branch, and only in one explicit form:
// `git push [-u|--set-upstream] origin <branch>`. Everything else is blocked:
// pushing main, a bare `git push` (it depends on the current branch), force
// pushes, deletes, refspecs with `:` or `+`, HEAD, other remotes, other flags
// and `git -c` overrides.
const PUSH_FLAGS = ['-u', '--set-upstream'];
const PROTECTED_BRANCHES = ['main', 'master'];
const BRANCH_NAME = /^[\w][\w./-]*$/;

function pushArgsProblem(args) {
  const rest = args.filter((a) => !PUSH_FLAGS.includes(a));
  const flag = rest.find((a) => a.startsWith('-'));
  if (flag) return `the ${flag} flag is not allowed`;
  if (rest.length !== 2 || rest[0] !== 'origin') {
    return 'name the remote and one branch: git push -u origin <branch>';
  }
  const branch = rest[1].replace(/^refs\/heads\//, '');
  if (
    !BRANCH_NAME.test(branch) ||
    branch === 'HEAD' ||
    branch.startsWith('refs/') ||
    branch.includes('..')
  ) {
    return `${rest[1]} is not a plain branch name`;
  }
  if (PROTECTED_BRANCHES.includes(branch)) return `${branch} is protected`;
  return null;
}

// Returns why a git push in the command is not allowed, or null.
function gitPushProblem(command) {
  const { segments, unclosed } = parse(command);
  if (unclosed && /\bgit\b[^\n;&|]*\bpush\b/.test(command)) {
    return 'a push inside an unterminated quote cannot be checked';
  }
  for (const tokens of segments) {
    let i = commandIndex(tokens);
    const nested = nestedCommand(tokens, i);
    const nestedProblem = nested && gitPushProblem(nested);
    if (nestedProblem) return nestedProblem;
    // xargs appends stdin to the arguments, so the refspecs cannot be checked.
    const viaXargs = tokens.slice(0, i).includes('xargs');
    if (basename(tokens[i++] ?? '') !== 'git') continue;
    let override = false;
    while (tokens[i]?.startsWith('-')) {
      if (tokens[i] === '-c' || tokens[i].startsWith('--config')) {
        override = true;
      }
      i += tokens[i] === '-C' || tokens[i] === '-c' ? 2 : 1;
    }
    if (tokens[i] !== 'push') continue;
    if (override) return 'git -c overrides are not allowed on push';
    if (viaXargs) return 'a push through xargs cannot be checked';
    const args = tokens
      .slice(i + 1)
      .filter((t, j, all) => t !== REDIRECT && all[j - 1] !== REDIRECT);
    const problem = pushArgsProblem(args);
    if (problem) return problem;
  }
  return null;
}

// Claude may open PRs to main with `gh`, and read. It may not merge, approve,
// retarget, open a PR against another base, or make `gh api` write calls.
const GH_API_BODY_FLAGS = /^(-f|-F|--field|--raw-field|--input)/;

// Every value of a flag given as `--name value`, `--name=value` or `-Xvalue`.
// All occurrences count: a flag that takes a value consumes the next token
// even if it looks like a flag, so the last one cannot be trusted to win.
function flagValues(args, long, short) {
  const values = [];
  args.forEach((a, j) => {
    if (a === `--${long}` || a === `-${short}`) values.push(args[j + 1] ?? '');
    else if (a.startsWith(`--${long}=`)) values.push(a.slice(long.length + 3));
    else if (!a.startsWith('--') && a.startsWith(`-${short}`)) {
      values.push(a.slice(short.length + 1).replace(/^=/, ''));
    }
  });
  return values;
}

function ghApiProblem(args) {
  const methods = flagValues(args, 'method', 'X').map((m) => m.toUpperCase());
  const writes =
    args.some((a) => GH_API_BODY_FLAGS.test(a)) ||
    flagValues(args, 'header', 'H').some((h) => /method-override/i.test(h));
  const ok = methods.length ? methods.every((m) => m === 'GET') : !writes;
  return ok ? null : 'gh api write calls are not allowed';
}

// An alias or extension can run a blocked call under a new name.
const GH_RENAME = 'gh aliases and extensions are not allowed';
// Word pairs that mean a blocked gh call wherever they appear in a segment,
// even when `gh` hides behind a variable, `$(which gh)` or `find -exec`.
// `merged` is a PR state (`gh pr list --state merged`), not a merge.
const GH_BACKSTOP = [
  [['pr'], /^merge(?!d$)/, 'merging is for the human'],
  [['alias'], /^(set|import)/, GH_RENAME],
  [['extension', 'ext'], /^(install|exec)/, GH_RENAME],
];

function ghBackstop(tokens) {
  for (const [firsts, second, reason] of GH_BACKSTOP) {
    const k = tokens.findIndex((t) => firsts.includes(t));
    if (k >= 0 && tokens.slice(k + 1).some((t) => second.test(t))) {
      return reason;
    }
  }
  return null;
}

// Returns why a gh call in the command is not allowed, or null.
function ghProblem(command) {
  const { segments, unclosed } = parse(command);
  if (
    unclosed &&
    /\bgh\b[^\n;&|]*(\b(merge|api)\b|\s(--base|-B|--approve|-a)\b)/.test(
      command,
    )
  ) {
    return 'a gh call inside an unterminated quote cannot be checked';
  }
  for (const tokens of segments) {
    const i = commandIndex(tokens);
    const nested = nestedCommand(tokens, i);
    const nestedProblem = nested && ghProblem(nested);
    if (nestedProblem) return nestedProblem;
    const backstop = ghBackstop(tokens);
    if (backstop) return backstop;
    if (basename(tokens[i] ?? '') !== 'gh') continue;
    // xargs appends stdin to the arguments, so they cannot be checked.
    if (tokens.slice(0, i).includes('xargs')) {
      return 'a gh call through xargs cannot be checked';
    }
    const args = tokens
      .slice(i + 1)
      .filter((t, j, all) => t !== REDIRECT && all[j - 1] !== REDIRECT);
    // Subcommands: the first words that are not flags (or a flag's value).
    const words = [];
    for (let j = 0; j < args.length && words.length < 2; j++) {
      if (args[j] === '-R' || args[j] === '--repo') j++;
      else if (!args[j].startsWith('-')) words.push(args[j]);
    }
    if (words[0] === 'api') {
      const problem = ghApiProblem(args);
      if (problem) return problem;
    }
    if (words[0] === 'alias' && ['set', 'import'].includes(words[1])) {
      return GH_RENAME;
    }
    if (
      ['extension', 'ext'].includes(words[0]) &&
      ['install', 'exec'].includes(words[1])
    ) {
      return GH_RENAME;
    }
    if (words[0] !== 'pr') continue;
    if (words[1] === 'merge') return 'merging is for the human';
    const bases = flagValues(args, 'base', 'B');
    if (words[1] === 'edit' && bases.length) {
      return 'retargeting a PR is not allowed';
    }
    if (
      words[1] === 'review' &&
      args.some((a) => /^--approve(=|$)/.test(a) || /^-[a-zA-Z]*a/.test(a))
    ) {
      return 'approving a PR is not allowed';
    }
    if (words[1] === 'create' && bases.some((b) => b !== 'main')) {
      return 'PRs may only target main';
    }
  }
  return null;
}

// The runner applies to jobs from a user's real LinkedIn account. Claude may
// develop it freely but may only launch it as a dry run. Slice 03 names it.
export const RUNNER_NAME = 'runner';
// Nx target names are listed as well as CLI words: the guard reads an Nx
// target as the subcommand.
export const RUNNER_SAFE_SUBCOMMANDS = [
  'bridge',
  'bridge-install',
  'bridge-check',
  'bridge-check-crash',
  'pace',
  'pace-record',
  'pace-record-typing',
  'pace-summary',
  'pace-build',
  'pace-practice',
  'pace-compare',
  'bot-check',
  'bot-check-repeat',
  'session',
  'facts',
  'facts-check',
  'answers',
  'answers-eval',
  'disqualify',
  'disqualify-eval',
  'snapshot',
  'snapshot-scrub',
];
export const DEV_TARGETS = ['build', 'test', 'lint', 'typecheck'];

const NODE_RUNNERS = ['node', 'tsx', 'ts-node'];
// The Nx CLI, run directly or as a file: `nx`, `.bin/nx`, `nx/bin/nx.js`.
const isNx = (t) => basename(t) === 'nx' || basename(t) === 'nx.js';
const PACKAGE_MANAGERS = ['pnpm', 'npx', 'npm', 'yarn'];
// Package-manager flags whose value selects a package or folder.
const PM_DIR_FLAGS = [
  '-C',
  '--dir',
  '-F',
  '--filter',
  '--prefix',
  '-w',
  '--workspace',
];
const PM_EXEC = ['exec', 'dlx', 'x'];
// Package-manager commands that never run a package script.
const PM_BUILTINS = [
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'list',
  'ls',
  'why',
  'outdated',
  'update',
  'up',
  'audit',
  'link',
  'unlink',
  'prune',
  'store',
  'config',
  'info',
  'view',
];
// Nx commands that inspect or change the workspace without running a target.
const NX_TOOLS = [
  'show',
  'graph',
  'g',
  'generate',
  'list',
  'report',
  'reset',
  'daemon',
  'format',
  'format:check',
  'format:write',
  'sync',
  'sync:check',
  'repair',
  'migrate',
  'add',
  'init',
];

const withoutRedirects = (tokens) =>
  tokens.filter((t, j, all) => t !== REDIRECT && all[j - 1] !== REDIRECT);
// A path through a folder named after the runner: apps/<name>/…, and also
// Nx's build output dist/apps/<name>/….
const runnerPath = (t, name) => {
  const s = segments(t);
  return s.some((x, k) => x === 'apps' && s[k + 1] === name);
};
const looksLikeFile = (t) => t.includes('/') || /\.[cm]?[jt]sx?$/.test(t);

// True when `--dry-run` reaches the runner: it comes after the launch token
// and before any `--` that would turn it into a plain argument. The first
// `skip` separators belong to the launcher (Nx forwards what follows `--`).
function dryRunAfter(args, at, skip) {
  for (let j = at + 1; j < args.length; j++) {
    if (args[j] === '--' && skip-- <= 0) return false;
    if (args[j] === '--dry-run') return true;
  }
  return false;
}

// Every target named by -t/--target/--targets, joined, separate, or listed
// with commas or spaces.
function nxTargets(args) {
  const targets = [];
  args.forEach((a, k) => {
    const m = /^(--targets?(?==|$)|-t)=?(.*)$/.exec(a);
    if (!m) return;
    if (m[2]) targets.push(...m[2].split(/[,\s]+/));
    else {
      for (let n = k + 1; n < args.length && !args[n].startsWith('-'); n++) {
        targets.push(...args[n].split(/[,\s]+/));
      }
    }
  });
  return targets.filter(Boolean);
}

// The launch in an Nx call (`args` follow `nx`), or null.
function nxLaunch(args, ctx, here) {
  const sep = args.indexOf('--');
  const own = sep < 0 ? args : args.slice(0, sep);
  const words = own.filter((a) => !a.startsWith('-'));
  const cmd = words[0];
  // A flag's value (`--output-style stream`) can come before the command, so
  // run-many/affected count anywhere among the words.
  if (words.includes('run-many') || words.includes('affected')) {
    const targets = nxTargets(own);
    return !targets.length || targets.some((t) => !DEV_TARGETS.includes(t))
      ? { problem: 'run-many with a non-dev target may launch the runner' }
      : null;
  }
  // `nx exec` and `nx watch` run the command after `--`.
  if ((cmd === 'exec' || cmd === 'watch') && sep >= 0) {
    const inner = args.slice(sep + 1).join(' ');
    return { problem: runnerProblem(inner, ctx.name, ctx.safe, here) };
  }
  if (!cmd || NX_TOOLS.includes(cmd)) return null;
  const spec = own.findIndex((a) => a.startsWith(`${ctx.name}:`));
  const projects = [
    ...flagValues(own, 'project', 'p'),
    ...flagValues(own, 'projects', 'p'),
  ].flatMap((v) => v.split(','));
  // Inside the runner's folder, Nx picks the runner when no project is named.
  // `nx <target>` with no project runs on the default project.
  const named =
    here ||
    own.includes(ctx.name) ||
    projects.includes(ctx.name) ||
    (words.length === 1 && !projects.length && cmd !== 'run');
  if (spec < 0 && !named) return null;
  let at = own.indexOf(cmd);
  let target = cmd;
  if (spec >= 0) {
    at = spec;
    target = own[spec].split(':')[1];
  } else if (cmd === 'run') {
    // `nx run <name>` without a target cannot be checked.
    at = words[1] ? own.indexOf(words[1]) : at;
    target = words[1]?.includes(':') ? words[1].split(':')[1] : undefined;
  }
  return DEV_TARGETS.includes(target)
    ? null
    : { args, at, subcommand: target, skip: 1 };
}

// With an inline script (`-e`, `--eval`, `-p`, `--print`) node runs no file:
// there is a launch only when the script names `apps/<name>`, and the launch
// token is then the first argument after the script (node's argv[1]).
const EVAL_FLAGS = ['-e', '--eval', '-p', '--print'];

// The launch when `args` run node, tsx or ts-node, or null. The launch token
// is the first argument that is a runner path, or, inside the runner's
// folder, the first non-flag argument. An argument expanded at run time
// (`$F`) counts when the command names the runner anywhere.
function fileLaunch(args, ctx, here) {
  const e = args.findIndex(
    (a, k) => k > 0 && (EVAL_FLAGS.includes(a) || /^--(eval|print)=/.test(a)),
  );
  if (e > 0) {
    const joined = args[e].includes('=');
    const script = joined
      ? args[e].slice(args[e].indexOf('=') + 1)
      : args[e + 1];
    if (!script?.includes(`apps/${ctx.name}`)) return null;
    const at = joined ? e + 1 : e + 2;
    return { args, at, subcommand: args[at + 1] };
  }
  let at = args.findIndex(
    (a, k) =>
      k > 0 && (runnerPath(a, ctx.name) || (ctx.mentioned && a.includes('$'))),
  );
  if (at < 0 && here)
    at = args.findIndex((a, k) => k > 0 && !a.startsWith('-'));
  return at < 0 ? null : { args, at, subcommand: args[at + 1] };
}

// Words that start a launch wherever they appear after a package manager.
const launchWord = (t, name) =>
  isNx(t) || NODE_RUNNERS.includes(basename(t)) || runnerPath(t, name);

// True when --filter, --dir, yarn workspace… name the runner, so the package
// manager runs in its folder.
const managerInRunner = (args, name) =>
  args.some((a, k) => {
    const value =
      PM_DIR_FLAGS.includes(a) || a === 'workspace' ? args[k + 1] : '';
    return (a.startsWith('-') && a.includes(name)) || value?.includes(name);
  });

// Where the command run by a package manager may start. A flag's value cannot
// always be told from the command word (`pnpm --reporter silent nx`), so after
// the first word that follows a flag, later words that follow it are also
// candidates when they start a launch. The value of a known value flag is a
// candidate only when it starts a launch. In pnpm, `-w` takes no value.
function managerCandidates(args, name) {
  const pnpm = basename(args[0]) === 'pnpm';
  let exec = basename(args[0]) === 'npx';
  const candidates = [];
  for (let j = 1; j < args.length; j++) {
    const a = args[j];
    const takesValue =
      (PM_DIR_FLAGS.includes(a) && !(pnpm && a === '-w')) || a === 'workspace';
    if (takesValue) {
      if (launchWord(args[j + 1] ?? '', name)) {
        candidates.push({ j: j + 1, exec });
      }
      j++;
    } else if (PM_EXEC.includes(a)) exec = true;
    else if (!a.startsWith('-')) {
      if (!candidates.length || launchWord(a, name)) {
        candidates.push({ j, exec });
      }
      // A word that does not follow a flag is the command word: stop.
      if (!args[j - 1].startsWith('-')) break;
    }
  }
  return candidates;
}

// The runner launch in one command (args start at the command word), or null.
// A result has the launch token's index `at` and the `subcommand`, or a
// `problem` when the call is blocked outright.
function findLaunch(args, ctx, here) {
  if (!PACKAGE_MANAGERS.includes(basename(args[0] ?? ''))) {
    return launchAt(args, 0, ctx, here, false, false);
  }
  const inRunner = here || managerInRunner(args, ctx.name);
  for (const { j, exec } of managerCandidates(args, ctx.name)) {
    const launch = launchAt(args, j, ctx, inRunner, true, exec);
    if (launch) return launch;
  }
  return null;
}

// The launch when the command word is `args[j]`, or null. `manager` is true
// when a package manager runs it, and `exec` when it runs it as a binary.
function launchAt(args, j, ctx, here, manager, exec) {
  const word = args[j];
  if (word === undefined) return null;
  const rest = args.slice(j);
  if (isNx(word)) return nxLaunch(rest.slice(1), ctx, here);
  if (NODE_RUNNERS.includes(basename(word))) {
    // `node node_modules/nx/bin/nx.js …` is an Nx call.
    const file = rest.findIndex((a, k) => k > 0 && !a.startsWith('-'));
    if (file > 0 && isNx(rest[file])) {
      return nxLaunch(rest.slice(file + 1), ctx, here);
    }
    return fileLaunch(rest, ctx, here);
  }
  if (
    runnerPath(word, ctx.name) ||
    word === ctx.name ||
    (here && looksLikeFile(word))
  ) {
    return { args: rest, at: 0, subcommand: rest[1] };
  }
  // A package script run in the runner's package: `pnpm start`, `npm run x`.
  if (manager && !exec && here) {
    const at = word === 'run' || word === 'run-script' ? 1 : 0;
    const script = rest[at];
    if (
      script &&
      !DEV_TARGETS.includes(script) &&
      !PM_BUILTINS.includes(script)
    ) {
      return { args: rest, at, subcommand: script };
    }
  }
  return null;
}

// Returns why a runner launch in the command is not allowed, or null.
// `here` is true once an earlier `cd` entered the runner's folder.
export function runnerProblem(
  command,
  runnerName,
  safeSubcommands,
  here = false,
) {
  if (!runnerName) return null;
  const ctx = {
    name: runnerName,
    safe: safeSubcommands,
    mentioned: command.includes(runnerName),
  };
  const { segments: parts, unclosed } = parse(command);
  if (unclosed && ctx.mentioned) {
    return 'a runner command inside an unterminated quote cannot be checked';
  }
  for (const tokens of parts) {
    const i = commandIndex(tokens);
    const nested = nestedCommand(tokens, i);
    const nestedProblem =
      nested && runnerProblem(nested, runnerName, safeSubcommands, here);
    if (nestedProblem) return nestedProblem;
    const args = withoutRedirects(tokens.slice(i));
    if (
      (args[0] === 'cd' || args[0] === 'pushd') &&
      args.slice(1).some((a) => segments(a).includes(runnerName))
    ) {
      here = true;
    }
    const launch = findLaunch(args, ctx, here);
    if (!launch) continue;
    if ('problem' in launch) {
      if (launch.problem) return launch.problem;
      continue;
    }
    const { at, subcommand, skip = 0 } = launch;
    if (safeSubcommands.includes(subcommand)) continue;
    if (dryRunAfter(launch.args, at, skip)) continue;
    return 'a real run is not allowed';
  }
  return null;
}

// Converts a shell glob to a regex: `*`, `?` and `[...]`.
const globRegex = (g) =>
  new RegExp(
    `^${g
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );
// Commands that change the files they name. A bare `private` word only counts
// as the folder after one of these: elsewhere it is often a plain word
// (`--set private`).
const FILE_CHANGERS = ['rm', 'rmdir', 'mv', 'cp', 'rsync', 'find', 'ln'];
// True when a token names the record: directly, through the private folder
// itself (`rm -rf private/`), or through a glob inside it (`rm private/*`).
function namesRecord(t, word) {
  if (t.includes(PROTECTED_RECORD)) return true;
  const s = segments(t).filter(Boolean);
  if (s.at(-1) === 'private' && (t.endsWith('/') || s.length > 1)) return true;
  if (t === 'private' && FILE_CHANGERS.includes(word)) return true;
  if (s.at(-2) !== 'private' || !/[*?[]/.test(s.at(-1))) return false;
  try {
    return globRegex(s.at(-1)).test(PROTECTED_RECORD);
  } catch {
    return true;
  }
}

// Returns why the command may change the applied-jobs record, or null. A
// segment that names it must be a read-only tool, with no in-place flag, and
// the record must not be a redirect target. Nested shells are checked too.
function recordWriteProblem(command) {
  const { segments, unclosed } = parse(command);
  if (unclosed && command.includes(PROTECTED_RECORD)) return RECORD_REASON;
  for (const tokens of segments) {
    const i = commandIndex(tokens);
    const nested = nestedCommand(tokens, i);
    const nestedProblem = nested && recordWriteProblem(nested);
    if (nestedProblem) return nestedProblem;
    const word = basename(tokens[i] ?? '');
    const names = (t) => namesRecord(t, word);
    if (!tokens.some(names)) continue;
    const readOnly =
      READ_ONLY_TOOLS.includes(word) &&
      !tokens.some((t) => t === '-i' || t.startsWith('--in-place')) &&
      !tokens.some((t, j) => names(t) && tokens[j - 1] === REDIRECT);
    if (!readOnly) return RECORD_REASON;
  }
  return null;
}

// Returns the first secret token, looking inside nested shells.
function findBlockedToken(command) {
  const { segments, unclosed } = parse(command);
  if (unclosed) {
    const raw = rawTokens(command).find(bashHit);
    if (raw) return raw;
  }
  for (const tokens of segments) {
    const nested = nestedCommand(tokens, commandIndex(tokens));
    const hit = nested && findBlockedToken(nested);
    if (hit) return hit;
    for (const token of tokens) {
      if (bashHit(token) || bashHit(token.slice(token.indexOf('=') + 1))) {
        return token;
      }
    }
  }
}

export function evaluate(
  { tool_name, tool_input = {} },
  { runnerName = RUNNER_NAME, safeSubcommands = RUNNER_SAFE_SUBCOMMANDS } = {},
) {
  if (tool_name === 'Bash') {
    const command = tool_input.command ?? '';
    const pushProblem = gitPushProblem(command);
    if (pushProblem) {
      return {
        block: true,
        reason: `git push blocked: ${pushProblem}. Claude may only run \`git push -u origin <branch>\` for a branch other than main; the human does anything else.`,
      };
    }
    const ghIssue = ghProblem(command);
    if (ghIssue) {
      return {
        block: true,
        reason: `gh blocked: ${ghIssue}. Claude may only open PRs to main; the human merges.`,
      };
    }
    const runnerIssue = runnerProblem(command, runnerName, safeSubcommands);
    if (runnerIssue) {
      return {
        block: true,
        reason: `Runner blocked: ${runnerIssue}. Claude may only start --dry-run runs, and only when the author asks (see CLAUDE.md).`,
      };
    }
    if (recordWriteProblem(command)) return blockRecord();
    const hit = findBlockedToken(command);
    if (hit) return blockPath(hit);
    return { block: false };
  }

  if (WRITE_TOOLS.includes(tool_name)) {
    for (const key of PATH_KEYS) {
      const value = tool_input[key];
      if (typeof value === 'string' && isRecord(value)) return blockRecord();
    }
  }

  const checks = [...(CHECKS[tool_name] ?? []), [PATH_KEYS, pathHit]];
  for (const [keys, hit] of checks) {
    for (const key of keys) {
      const value = tool_input[key];
      if (typeof value === 'string' && hit(value)) return blockPath(value);
    }
  }
  return { block: false };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const result = evaluate(event ?? {});
  if (result.block) {
    console.error(result.reason);
    process.exit(2);
  }
}
