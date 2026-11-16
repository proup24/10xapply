import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  let tick = false;
  // Open `(` count: a `)` with none open closes a `case` pattern.
  let depth = 0;
  // True when a `$'…'` span never closes.
  let open = false;
  const endToken = () => {
    if (token) segments.at(-1).push(token.replace(/^\.\//, ''));
    token = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        // `\<newline>` is removed inside "..." too.
        if (command[++i] !== '\n') token += command[i];
      } else token += ch;
    } else if (ch === '\\') {
      // Bash deletes `\<newline>` without ending the word.
      if (command[i + 1] !== '\n') token += command[i + 1] ?? '';
      i++;
    } else if (
      ch === '$' &&
      (command[i + 1] === '"' || command[i + 1] === "'")
    ) {
      // `$'…'` and `$"…"` quote like '…' and "…": drop the `$`, as bash
      // does. Inside `$'…'` a backslash escapes the next character, so `\'`
      // does not end it. A span with a backslash escape (`\x73`) keeps its
      // `$`, so it reads as an expansion and fails closed.
      if (command[i + 1] === "'") {
        let j = i + 2;
        while (j < command.length && command[j] !== "'") {
          j += command[j] === '\\' ? 2 : 1;
        }
        if (j >= command.length) open = true;
        const span = command.slice(i + 2, j);
        token += (span.includes('\\') ? '$' : '') + span;
        i = j;
      }
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
      // An opening backtick leaves a marker where the substitution stands.
      if (ch === '`' && (tick = !tick)) segments.at(-1).push('`');
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth > 0) depth--;
        else segments.at(-1).casePattern = true;
      }
      segments.push([]);
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token += ch;
    }
  }
  endToken();
  return { segments, unclosed: quote !== null || open };
}

const WRAPPERS = [
  'sudo',
  'env',
  'time',
  'command',
  'builtin',
  'nice',
  'exec',
  'xargs',
  'nohup',
];
// stdbuf flags that take a value when it is not joined (`-o 0`, `--output 0`).
const STDBUF_VALUE_FLAG = /^(-[ioe]|--(input|output|error))$/;
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
// A wrapper counts by its last path segment (`/usr/bin/env`).
function commandIndex(tokens) {
  let i = 0;
  for (;;) {
    const t = tokens[i];
    const w = basename(t ?? '');
    if (KEYWORDS.includes(t) || /^\w+=/.test(t ?? '')) i++;
    else if (w === 'timeout') {
      i++;
      while (tokens[i]?.startsWith('-')) {
        i += tokens[i] === '-k' || tokens[i] === '-s' ? 2 : 1;
      }
      i++; // the duration
    } else if (w === 'stdbuf') {
      i++;
      while (tokens[i]?.startsWith('-')) {
        i += STDBUF_VALUE_FLAG.test(tokens[i]) ? 2 : 1;
      }
    } else if (WRAPPERS.includes(w)) {
      i++;
      // wrapper flags (`--` too); `-n` (nice) and `-u` (env) take a value
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
  // Node stops reading its own options at the script: an eval flag counts
  // only before the first non-flag argument.
  let e = -1;
  for (let k = 1; k < args.length && args[k].startsWith('-'); k++) {
    if (EVAL_FLAGS.includes(args[k]) || /^--(eval|print)=/.test(args[k])) {
      e = k;
      break;
    }
  }
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

// --- Supabase CLI (spec section 6) -----------------------------------------
// The CLI on this machine is signed in to an account that also holds other
// projects, so Claude may run the local stack only. An allowlist on the full
// sequence of positional words: anything not named here is refused.
// `supabase`, a path ending in it, or a package spec `supabase@2.x`.
const isSupabaseCli = (t) => /^supabase(@[^/]*)?$/.test(basename(t ?? ''));
// The CLI word in raw text: not part of a longer name (`supabase-env.sh`) or
// a folder (`supabase/config.toml`).
const CLI_WORD = /(?<![\w.-])supabase(?![\w./-])/;
// Flags that take a value, so the value is not a positional word. Any other
// flag counts as boolean unless it carries `=value`.
const SUPABASE_VALUE_FLAGS = [
  '--workdir',
  '--profile',
  '-o',
  '--output',
  '--network-id',
  '--dns-resolver',
  '-x',
  '--exclude',
  '--schema',
  '-s',
  '--algorithm',
  '--status',
];
// Flags that point any command at a remote database or project.
const SUPABASE_REMOTE_FLAGS = [
  '--project-ref',
  '--project-id',
  '--linked',
  '--db-url',
  '--password',
];
const GEN_LANGS = ['typescript', 'go', 'swift', 'python'];
// The allowed positional sequences, and the flag each one needs.
const SUPABASE_ALLOWED = new Map([
  ['', null], // `supabase`, `supabase --help`, `supabase --version`
  ['start', null],
  ['stop', null],
  ['status', null],
  ['gen types', '--local'],
  ...GEN_LANGS.map((l) => [`gen types ${l}`, '--local']),
  ['gen signing-key', null],
  ['db reset', null],
  ['migration list', '--local'],
]);
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const flagName = (a) => a.split('=')[0];
const remoteFlag = (a) =>
  SUPABASE_REMOTE_FLAGS.includes(flagName(a)) || /^-p/.test(a);
const insideRepo = (v) =>
  // parse strips a leading `./`, so `./` arrives as ''.
  v === '' ||
  v === '.' ||
  v === './' ||
  (isAbsolute(v) &&
    (resolve(v) === REPO_ROOT || resolve(v).startsWith(REPO_ROOT + sep)));

// Why one CLI call (`args` follow the CLI word) is refused, or null.
function supabaseArgsProblem(args) {
  const flag = args.find(remoteFlag);
  if (flag) return `the ${flagName(flag)} flag reaches a remote project`;
  const positionals = [];
  const flags = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '--') continue;
    if (SUPABASE_VALUE_FLAGS.includes(a)) {
      flags.push([a, args[++j] ?? '']);
    } else if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      flags.push(eq < 0 ? [a, undefined] : [a.slice(0, eq), a.slice(eq + 1)]);
    } else positionals.push(a);
  }
  if (flags.some(([n]) => n === '--all')) {
    return '--all reaches other local stacks';
  }
  if (flags.some(([n, v]) => n === '--workdir' && !insideRepo(v ?? ''))) {
    return '--workdir must stay inside the repo';
  }
  const key = positionals.join(' ');
  if (!SUPABASE_ALLOWED.has(key)) {
    return `\`supabase ${key}\` is not a local command`;
  }
  const needs = SUPABASE_ALLOWED.get(key);
  if (needs && !flags.some(([n]) => n === needs)) {
    return `\`supabase ${key}\` needs ${needs}`;
  }
  return null;
}

// The text of every `$(…)`, `<(…)`, `>(…)` and backtick substitution. Bash
// does not expand them inside single quotes, so those spans are skipped.
function substitutions(command) {
  const out = [];
  let dquote = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\') i++;
    else if (ch === '$' && command[i + 1] === "'" && !dquote) {
      // `$'…'`: a backslash escapes the next character, a quote included.
      let j = i + 2;
      while (j < command.length && command[j] !== "'") {
        j += command[j] === '\\' ? 2 : 1;
      }
      i = j;
    } else if (ch === "'" && !dquote) {
      const j = command.indexOf("'", i + 1);
      i = j < 0 ? command.length : j;
    } else if (ch === '"') dquote = !dquote;
    else if (/[$<>]/.test(ch) && command[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')' && --depth === 0) break;
      }
      out.push(command.slice(i + 2, j));
      i = j;
    } else if (ch === '`') {
      const j = command.indexOf('`', i + 1);
      out.push(command.slice(i + 1, j < 0 ? command.length : j));
      i = j < 0 ? command.length : j;
    }
  }
  return out;
}

// The command words the opt-in check accepts: they only read and print.
const TEXT_READERS = ['grep', 'rg', 'cat', 'head', 'tail', 'less', 'wc'];
const GIT_READS = ['diff', 'log', 'show', 'grep'];
// A sed script with an e (run), w or W (write) command, or the s///e or
// s///w flag. Every argument is tested, so a file named like one fails
// closed.
const SED_RUNS = /[0-9$/]\s*[ewW]\b|^\s*[ewW]\b|;\s*[ewW]\b/;
// Flags that make a reader run another program.
const READER_RUNS = {
  rg: /^--pre(?![\w-])/,
  ugrep: /^--filter/,
};
// git flags that run a pager or diff program, or write a file.
const GIT_RUNS = /^(-O|--open-files-in-pager|--output|--ext-diff)/;

// The index of the git subcommand, or -1 when a git flag may change what
// git runs (`-c`, `--config`, `--exec-path`).
function gitSubcommand(tokens) {
  let j = 1;
  while (tokens[j]?.startsWith('-')) {
    if (/^(-c|--config|--exec-path)/.test(tokens[j])) return -1;
    j += tokens[j] === '-C' ? 2 : 1;
  }
  return j;
}

// True when the segment only reads. The command word must come first (no
// assignments or wrappers in front). With `strict`, a redirect may only
// target /dev/null. `extra` lists more read-only command words.
function readOnlySegment(tokens, { strict = true, extra = [] } = {}) {
  if (!tokens.length || commandIndex(tokens) !== 0) return false;
  if (
    strict &&
    tokens.some((t, j) => tokens[j - 1] === REDIRECT && t !== '/dev/null')
  ) {
    return false;
  }
  const w = basename(tokens[0]);
  const args = tokens.slice(1);
  if (READER_RUNS[w] && args.some((t) => READER_RUNS[w].test(t))) return false;
  if (TEXT_READERS.includes(w) || extra.includes(w)) return true;
  if (w === 'sed') {
    return !args.some(
      (t) =>
        t.startsWith('--in-place') ||
        /^-[a-zA-Z]*i/.test(t) ||
        SED_RUNS.test(t),
    );
  }
  if (w !== 'git') return false;
  const j = gitSubcommand(tokens);
  if (j < 0 || !GIT_READS.includes(tokens[j])) return false;
  return !tokens.slice(j + 1).some((t) => GIT_RUNS.test(t));
}

// In a read-only grep, rg, ugrep or git grep, the first non-flag argument is
// the search pattern, never run: its index, or -1.
function patternIndex(tokens) {
  const w = basename(tokens[0] ?? '');
  let start = -1;
  if (['grep', 'rg', 'ugrep'].includes(w)) start = 1;
  else if (w === 'git') {
    const j = gitSubcommand(tokens);
    if (j > 0 && tokens[j] === 'grep') start = j + 1;
  }
  if (start < 0) return -1;
  for (let j = start; j < tokens.length; j++) {
    if (tokens[j] === REDIRECT) j++;
    else if (!tokens[j].startsWith('-')) return j;
  }
  return -1;
}

// The CLI word, or part of it, in any spelling.
const CLI_PART = /supabas|upabase/i;
// Characters that make bash build a word at run time: variables, braces,
// globs and substitutions.
const EXPANSION = /[$`{}?*[]/;
// A committed repo script run through a substitution, as in
// `eval "$(scripts/supabase-env.sh)"`.
const REPO_SCRIPT = /^scripts\/[\w.-]+$/;
// Variables the CLI may read; the local stack's own values are allowed.
const SUPABASE_ENV_OK = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
];
const supabaseEnv = (t) => {
  const m = /^(SUPABASE_[A-Z0-9_]+)\+?=/.exec(t);
  return m && !SUPABASE_ENV_OK.includes(m[1]) ? m[1] : null;
};

// A cd or pushd target that stays in the repo: an absolute path inside it,
// or a relative one with no `..`, `~` or `$` (the shell starts in the repo).
const cdInsideRepo = (v) =>
  v !== undefined &&
  (insideRepo(v) || (!isAbsolute(v) && !/\.\.|~|\$|^-/.test(v)));

// A CDPATH assignment or export makes a relative cd land anywhere, and an
// npm_config_* variable can move a package manager's folder.
const MOVES_DIR = /^(CDPATH(\+?=|$)|(npm|pnpm|yarn)_config_\w+\+?=)/i;

// The values of a package manager's directory flags in a segment: `-C`,
// `--dir`, `--prefix` and `--cwd`, joined or separate. A missing value is
// undefined, which is not inside the repo.
const DIR_FLAGS = ['-C', '--dir', '--prefix', '--cwd'];
function dirFlagValues(tokens) {
  const dirs = [];
  tokens.forEach((t, k) => {
    if (DIR_FLAGS.includes(t)) dirs.push(tokens[k + 1]);
    else if (/^--(dir|prefix|cwd)=/.test(t)) {
      dirs.push(t.slice(t.indexOf('=') + 1));
    } else if (/^-C./.test(t)) dirs.push(t.slice(2).replace(/^=/, ''));
  });
  return dirs;
}

// The `env -C <dir>` and `env --chdir[=]<dir>` values in a segment.
function envChdirs(tokens) {
  const dirs = [];
  tokens.forEach((t, k) => {
    if (basename(t) !== 'env') return;
    for (let j = k + 1; j < tokens.length; j++) {
      const a = tokens[j];
      if (a === '-C' || a === '--chdir') dirs.push(tokens[++j]);
      else if (a.startsWith('--chdir=')) dirs.push(a.slice(8));
      else if (/^-C./.test(a)) dirs.push(a.slice(2));
      else if (!a.startsWith('-') && !/^\w+=/.test(a)) break;
    }
  });
  return dirs;
}

// Indexes of the words a launcher runs, besides the command word itself:
// the word after `pnpm exec`/`dlx`, `npx`, `npm exec`, `yarn` and `setsid`.
// env, xargs, nohup, time, command, exec and sudo are skipped by
// commandIndex, so the command word is already the word they run.
function launchedWords(args) {
  const out = [];
  const w = basename(args[0] ?? '');
  if (w === 'setsid') {
    const j = args.findIndex((a, k) => k > 0 && !a.startsWith('-'));
    if (j > 0) out.push(j);
  }
  if (PACKAGE_MANAGERS.includes(w)) {
    let exec = false;
    for (let j = 1; j < args.length; j++) {
      const a = args[j];
      if (PM_DIR_FLAGS.includes(a)) j++;
      else if (a.startsWith('-')) continue;
      else if (!exec && PM_EXEC.includes(a)) exec = true;
      else {
        out.push(j);
        break;
      }
    }
  }
  return out;
}

// True when the segment would be read-only but for a flag or sed command
// that runs another program (SED_RUNS, READER_RUNS, GIT_RUNS).
function readerRuns(tokens, i) {
  const t = tokens.slice(i);
  const w = basename(t[0] ?? '');
  const args = t.slice(1);
  if (READER_RUNS[w]) return args.some((a) => READER_RUNS[w].test(a));
  if (w === 'sed') return args.some((a) => SED_RUNS.test(a));
  if (w !== 'git') return false;
  const j = gitSubcommand(t);
  return (
    j > 0 &&
    GIT_READS.includes(t[j]) &&
    t.slice(j + 1).some((a) => GIT_RUNS.test(a))
  );
}

// The indexes of `git commit -m`/`--message` values: prose, not commands.
function commitMessages(tokens, i) {
  const skip = new Set();
  if (basename(tokens[i] ?? '') !== 'git') return skip;
  const t = tokens.slice(i);
  const sub = gitSubcommand(t);
  if (sub < 0 || t[sub] !== 'commit') return skip;
  for (let j = sub + 1; j < t.length; j++) {
    if (t[j] === '--message' || /^-[a-zA-Z]*m$/.test(t[j])) skip.add(i + ++j);
    else if (t[j].startsWith('--message=') || /^-[a-zA-Z]*m./.test(t[j])) {
      if (!t[j].startsWith('--') || t[j].startsWith('--message=')) {
        skip.add(i + j);
      }
    }
  }
  return skip;
}

// Problems with a command word of any program, not only the CLI: evaluate
// gives them a neutral reason.
const WORD_SUBSTITUTED = 'a command run from a substitution cannot be checked';
const WORD_EXPANDED = 'a command word built by expansion cannot be checked';
// Shell syntax that stands as a command word: `[ -f x ]`, `[[ … ]]` and the
// two ends of a `{ …; }` group.
const SYNTAX_WORDS = ['[', '[[', '{', '}'];

// Why a word bash runs is refused, or null: it must not be built by
// expansion. A lone `$` or backtick token is a substitution in that place;
// only a committed repo script may run there.
function launchWordProblem(word, next) {
  if (word === undefined || SYNTAX_WORDS.includes(word)) return null;
  if (word === '$' || word === '`') {
    return next?.length === 1 && REPO_SCRIPT.test(next[0])
      ? null
      : WORD_SUBSTITUTED;
  }
  return EXPANSION.test(word) ? WORD_EXPANDED : null;
}

// A `case` arm's pattern, as in `*) echo b;;`: one glob word that ended at
// a `)` with no `(` open, while a `case` is still open (more `case` words
// than `esac` before it). Bash matches it and never runs it. A word with
// `$`, a backtick or a brace is not taken for one.
const CASE_PATTERN = /^[\w.*?[\]!^+@,:/-]+$/;
const count = (segments, w) => segments.flat().filter((t) => t === w).length;
const isCasePattern = (tokens, earlier) =>
  tokens.casePattern === true &&
  tokens.length === 1 &&
  CASE_PATTERN.test(tokens[0]) &&
  count(earlier, 'case') > count(earlier, 'esac');

// Commands that take the bare word `supabase` as a folder name or as text
// and never run it. Each test gets the words after the command word and
// says whether no flag there makes the command run a program.
const GIT_FILE_COMMANDS = [
  'add',
  'status',
  'diff',
  'log',
  'show',
  'grep',
  'ls-files',
  'ls-tree',
  'blame',
  'restore',
  'checkout',
  'reset',
  'rm',
  'mv',
  'stash',
  'commit',
  'check-ignore',
];
const FIND_RUNS = /^-(exec|ok)(dir)?$/;
const FOLDER_WORDS = {
  ls: () => true,
  cat: () => true,
  mkdir: () => true,
  rm: () => true,
  grep: () => true,
  rg: (args) => !args.some((a) => READER_RUNS.rg.test(a)),
  find: (args) => !args.some((a) => FIND_RUNS.test(a)),
  // Only the plain letter bundle: `-I`, `--to-command` and the like run a
  // program.
  tar: (args) =>
    /^-?[cxtzjJvf]+$/.test(args[0] ?? '') &&
    !args.slice(1).some((a) => a.startsWith('-')),
  prettier: (args) => !args.some((a) => a.startsWith('--plugin')),
  npm: (args) => ['view', 'info', 'show'].includes(args[0]),
  git: (args) => {
    const t = ['git', ...args];
    const j = gitSubcommand(t);
    return (
      j > 0 &&
      GIT_FILE_COMMANDS.includes(t[j]) &&
      !t.slice(j + 1).some((a) => GIT_RUNS.test(a))
    );
  },
};
// cp and mv could copy the CLI binary under another name from a folder that
// holds it, and echo's output could be piped or written to a script: these
// three count only at the top level (not inside `bash -c`), with no cd in
// the command, and echo with no pipe, redirect or expansion anywhere.
const FOLDER_WORDS_TOP = ['cp', 'mv', 'echo'];

// True when the segment's command word only names the `supabase` folder (or
// prints the word): the bare token is then not a launch. Only shell keywords
// may precede the command word, or `xargs` before grep (it appends file
// names). `pnpm prettier` and `pnpm exec prettier` count as prettier.
function folderOnly(tokens, i, { command, parts, inner }) {
  let w = tokens[i];
  let args = withoutRedirects(tokens.slice(i + 1));
  if (w === 'pnpm' || w === 'npx') {
    const [j] = launchedWords([w, ...args]);
    if (j === undefined || args[j - 1] !== 'prettier') return false;
    w = 'prettier';
    args = args.slice(j);
  }
  const before = tokens.slice(0, i);
  const viaXargs =
    w === 'grep' &&
    before[0] === 'xargs' &&
    before.slice(1).every((t) => t.startsWith('-'));
  if (!viaXargs && !before.every((t) => KEYWORDS.includes(t))) return false;
  if (FOLDER_WORDS_TOP.includes(w)) {
    if (inner) return false;
    const moves = parts.some((p) =>
      ['cd', 'pushd', 'popd'].includes(p[commandIndex(p)]),
    );
    if (moves || parts.flat().some((t) => MOVES_DIR.test(t))) return false;
    return w !== 'echo' || !/[|<>$`]/.test(command);
  }
  return Object.hasOwn(FOLDER_WORDS, w) && FOLDER_WORDS[w](args);
}

// Returns why a Supabase CLI call in the command is refused, or null.
// `away` is true once an earlier `cd` or `pushd` left the repo. `inner` is
// true for a command string run by another command (`bash -c '…'`).
export function supabaseCliProblem(command, away = false, inner = false) {
  const { segments: parts, unclosed } = parse(command);
  if (
    unclosed &&
    (rawTokens(command).some(isSupabaseCli) || CLI_WORD.test(command))
  ) {
    return 'a supabase call inside an unterminated quote cannot be checked';
  }
  const subs = substitutions(command);
  if (subs.some((s) => CLI_WORD.test(s))) {
    return 'a supabase call inside a command substitution cannot be checked';
  }
  // An exported variable reaches every later segment.
  const env = parts.flat().map(supabaseEnv).find(Boolean);
  if (parts.flat().some((t) => MOVES_DIR.test(t))) away = true;
  for (const [n, tokens] of parts.entries()) {
    if (isCasePattern(tokens, parts.slice(0, n))) continue;
    const i = commandIndex(tokens);
    const args = withoutRedirects(tokens.slice(i));
    for (const k of [0, ...launchedWords(args)]) {
      const problem = launchWordProblem(args[k], parts[n + 1]);
      if (problem) return problem;
    }
    const nested = nestedCommand(tokens, i);
    const nestedProblem = nested && supabaseCliProblem(nested, away, true);
    if (nestedProblem) return nestedProblem;
    // A shell reading its commands from stdin or a here-string.
    if (
      SHELLS.includes(basename(tokens[i] ?? '')) &&
      nested === undefined &&
      CLI_WORD.test(command)
    ) {
      return 'a shell reading a supabase command from input cannot be checked';
    }
    if (['cd', 'pushd', 'popd'].includes(args[0])) {
      const rest = args.slice(1);
      const target = rest.find((a) => !a.startsWith('-'));
      // popd, and a `+N` or `-N` entry of the directory stack, land on a
      // folder the command does not name.
      if (
        args[0] === 'popd' ||
        rest.some((a) => /^[+-]\d+$/.test(a)) ||
        !cdInsideRepo(target)
      ) {
        away = true;
      }
      continue;
    }
    const segmentAway =
      away ||
      [...envChdirs(tokens), ...dirFlagValues(tokens)].some(
        (d) => !cdInsideRepo(d),
      );
    const readOnly = readOnlySegment(tokens, {
      strict: false,
      extra: READ_ONLY_TOOLS,
    });
    // A token with spaces may be a command run by `script -c`, `npx -c`,
    // `env -S`, `sed e` and the like: check it as one. A read-only search's
    // pattern and a commit message are never run.
    const skip = commitMessages(tokens, i);
    if (readOnly) skip.add(patternIndex(tokens));
    const folder = folderOnly(tokens, i, { command, parts, inner });
    // echo prints its words: none of them is run.
    if (folder && tokens[i] === 'echo') tokens.forEach((_, j) => skip.add(j));
    for (const [j, t] of tokens.entries()) {
      if (skip.has(j) || !/\s/.test(t) || !CLI_PART.test(t)) continue;
      // The command may be glued to a flag: `-O'cmd'`, `--flag=cmd`.
      const unglued = t.replace(/^--[\w-]+=|^-[A-Za-z]/, '');
      for (const text of new Set([t, unglued])) {
        const problem = supabaseCliProblem(text, segmentAway, true);
        if (problem) return problem;
      }
    }
    if (readOnly) continue;
    // A reader made to run a program named by a glued flag value.
    if (
      readerRuns(tokens, i) &&
      tokens.some((t) => {
        const u = t.replace(/^--[\w-]+=|^-[A-Za-z]/, '');
        return isSupabaseCli(u) || /supabase(\s|$)/.test(u);
      })
    ) {
      return 'a reader that runs a program names supabase';
    }
    if (
      tokens.some(
        (t) => /^\w+=/.test(t) && isSupabaseCli(t.slice(t.indexOf('=') + 1)),
      )
    ) {
      return 'the supabase word in a variable cannot be checked';
    }
    const cli = withoutRedirects(tokens);
    let launched = false;
    for (let k = 0; k < cli.length; k++) {
      if (!isSupabaseCli(cli[k])) continue;
      // The folder's name given to a command that never runs it.
      if (folder && cli[k] === 'supabase') continue;
      launched = true;
      if (cli.slice(k + 1).some((a) => EXPANSION.test(a))) {
        return 'a supabase argument built by expansion cannot be checked';
      }
      const problem = supabaseArgsProblem(cli.slice(k + 1));
      if (problem) return problem;
    }
    if (!launched) continue;
    // The segment split hides `supabase \`echo link\``: with any
    // substitution in the command, a launch cannot be checked.
    if (subs.length) {
      return 'a supabase call next to a command substitution cannot be checked';
    }
    // xargs appends stdin to the arguments, so they cannot be checked.
    if (tokens.includes('xargs')) {
      return 'a supabase call through xargs cannot be checked';
    }
    if (segmentAway) {
      return 'a cd, pushd, popd, CDPATH or directory flag out of the repo comes first';
    }
    if (env) return `${env} points the CLI away from the local stack`;
  }
  return null;
}

// CI alone opts the database scripts in to a remote database. The check is
// on text: a command that mentions ALLOW_REMOTE is refused unless every
// segment only reads. An assignment of the variable is refused anywhere.
const REMOTE_OPT_IN = /(?<![A-Za-z0-9_])XAPPLY_ALLOW_REMOTE_DB\+?=/;
const OPT_IN_TEXT = 'ALLOW_REMOTE';
const OPT_IN = 'the remote database opt-in';
export function remoteOptInProblem(command) {
  const { segments: parts, unclosed } = parse(command);
  const tokens = parts.flat();
  if (tokens.some((t) => REMOTE_OPT_IN.test(t))) return OPT_IN;
  // Bash drops `\<newline>` and `$'…'` quoting joins words, so the text is
  // also read with those removed.
  const texts = [
    command,
    command.replace(/\\\n/g, ''),
    tokens.join(' ').replace(/\$/g, ''),
  ];
  if (!texts.some((t) => t.includes(OPT_IN_TEXT))) return null;
  if (unclosed) return OPT_IN;
  const reads = parts.every((t) => t.length === 0 || readOnlySegment(t));
  return reads ? null : OPT_IN;
}

// --- Supabase MCP tools (spec section 6) -----------------------------------
// An allowlist: a Supabase tool not named here is refused. The key is the
// tool's suffix after the last `__`; the value is the argument that holds
// the project ref.
export const SUPABASE_REF_TOOLS = {
  list_tables: 'project_id',
  list_extensions: 'project_id',
  list_migrations: 'project_id',
  get_advisors: 'project_id',
  get_project_url: 'project_id',
  get_publishable_keys: 'project_id',
  generate_typescript_types: 'project_id',
  query_logs: 'project_id',
  execute_sql: 'project_id',
  get_project: 'id',
};

export const SUPABASE_NO_PROJECT_TOOLS = [
  'list_projects',
  'list_organizations',
  'get_organization',
  'search_docs',
];

const SUPABASE_TOOL = /^mcp__.*supabase/i;
const SUPABASE_PROJECT_FILE = new URL(
  '../supabase-project.json',
  import.meta.url,
);

// The committed ref, or null when the file is missing, unreadable or holds
// anything but a non-empty string.
export function readSupabaseProjectRef(fileUrl = SUPABASE_PROJECT_FILE) {
  try {
    const ref = JSON.parse(readFileSync(fileUrl, 'utf8'))?.projectRef;
    return typeof ref === 'string' && ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}

// Comments are replaced by a space, as Postgres treats them. Block comments
// nest, as in Postgres, and a line comment ends at \n or \r. Strings and
// quoted identifiers are kept (keywords inside them still count) so that a
// `--` inside a string is not taken for a comment. Returns null when a block
// comment is never closed.
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out += ' ';
    } else if (two === '/*') {
      let depth = 0;
      while (i < sql.length) {
        const pair = sql.slice(i, i + 2);
        if (pair === '/*') {
          depth++;
          i += 2;
        } else if (pair === '*/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      if (depth !== 0) return null;
      out += ' ';
    } else if (c === "'" || c === '"') {
      const escapes =
        c === "'" &&
        /[eE]/.test(sql[i - 1] ?? '') &&
        !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const word = (w) =>
  new RegExp(
    `(?<![A-Za-z0-9_$])${w.split(' ').join('\\s+')}(?![A-Za-z0-9_$])`,
    'i',
  );
const SQL_FIRST_WORDS = ['select', 'with', 'insert', 'update', 'delete'];
const SQL_KEYWORDS = [
  'create',
  'alter',
  'drop',
  'truncate',
  'grant',
  'revoke',
  'comment',
  'security',
  'do',
  'copy',
  'call',
  'set role',
  'reset role',
  'set session',
].map((w) => [w, word(w)]);
const SQL_WRITE = word('(?:insert|update|delete|merge)');
const SQL_SYSTEM_SCHEMA = word(
  '(?:auth|storage|supabase_migrations|extensions|information_schema|prisma_contract|pg_[A-Za-z0-9_$]*)',
);
// U&"..." spells an identifier with escapes, so it could name a system
// schema or a refused function without its letters.
const SQL_UNICODE_IDENT = /u&"/i;
const SQL_MAX_LENGTH = 20000;
const SQL_INTO = word('into');
const SQL_INSERT_INTO = new RegExp(
  `(?<![A-Za-z0-9_$])(?:insert|merge)\\s+into(?![A-Za-z0-9_$])`,
  'gi',
);
const SQL_DOLLAR_QUOTE = /\$[^$\s]*\$/;

// An identifier: plain, "quoted" or U&"escaped"; and a dotted chain of them.
const SQL_IDENT = `(?:[uU]&"(?:[^"]|"")*"|"(?:[^"]|"")*"|[A-Za-z_\\u0080-\\uffff][A-Za-z0-9_$\\u0080-\\uffff]*)`;
const SQL_CHAIN = `${SQL_IDENT}(?:\\s*\\.\\s*${SQL_IDENT})*`;
const chainParts = (chain) =>
  [...chain.matchAll(new RegExp(SQL_IDENT, 'g'))].map((m) => m[0]);
const isPublic = (part) =>
  part === '"public"' || part.toLowerCase() === 'public';

// Upsert clauses are the only place `do` may appear mid-statement.
const SQL_UPSERT_DO =
  /(?<![A-Za-z0-9_$])do\s+(?:nothing|update\s+set)(?![A-Za-z0-9_$])/gi;

const SQL_WRITE_WORD =
  /(?<![A-Za-z0-9_$])(insert|update|delete|merge)(?![A-Za-z0-9_$])/gi;
const SQL_WRITE_HEAD = {
  insert: /^insert\s+into\s+/i,
  update: /^update\s+(?:only\s+)?/i,
  delete: /^delete\s+from\s+(?:only\s+)?/i,
  merge: /^merge\s+into\s+/i,
};
const SQL_TARGET = new RegExp(`^${SQL_CHAIN}`);

// Every insert, update, delete or merge must write an unqualified table or
// public.<table>. `do update set` (an upsert) and `for [no key] update` (a
// row lock) are not write heads. A write word the check cannot read as one
// of these is refused. Returns the problem, or the target spans (so the
// function check can skip `insert into public.users (`).
function writeTargets(text) {
  const spans = [];
  for (const m of text.matchAll(SQL_WRITE_WORD)) {
    const kw = m[1].toLowerCase();
    const before = text.slice(0, m.index);
    const rest = text.slice(m.index);
    if (
      kw === 'update' &&
      /(?:^|[^A-Za-z0-9_$])do\s+$/i.test(before) &&
      /^update\s+set(?![A-Za-z0-9_$])/i.test(rest)
    )
      continue;
    if (
      kw === 'update' &&
      /(?:^|[^A-Za-z0-9_$])for\s+(?:no\s+key\s+)?$/i.test(before)
    )
      continue;
    const head = SQL_WRITE_HEAD[kw].exec(rest);
    const target = head && SQL_TARGET.exec(rest.slice(head[0].length));
    if (!target) return { problem: `a ${kw} the check cannot read; ${REWORD}` };
    const parts = chainParts(target[0]);
    if (parts.length > 2 || (parts.length === 2 && !isPublic(parts[0]))) {
      return {
        problem: `a write to a table outside public (writes reach public tables only); ${REWORD}`,
      };
    }
    const start = m.index + head[0].length;
    spans.push([start, start + target[0].length]);
  }
  return { spans };
}

const SQL_QUALIFIED_CALL = new RegExp(
  `${SQL_IDENT}(?:\\s*\\.\\s*${SQL_IDENT})+\\s*\\(`,
  'g',
);
const SQL_READ_ONLY_CALLS = ['uid', 'jwt'];
const isReadOnlyCall = (parts) =>
  parts.length === 2 &&
  (parts[0] === '"auth"' || parts[0].toLowerCase() === 'auth') &&
  SQL_READ_ONLY_CALLS.some(
    (f) => parts[1] === `"${f}"` || parts[1].toLowerCase() === f,
  );
const W = '[A-Za-z0-9_$]*';
// setval and nextval move a sequence, which is a write the table check
// cannot hold to public (`setval('auth.refresh_tokens_id_seq', 1)`).
const SQL_SIDE_EFFECT_CALL = new RegExp(
  `(?<![A-Za-z0-9_$])"?(?:set_config|setval|nextval|dblink${W}|lo_${W}|pg_read${W}|pg_ls${W}|pg_stat_file|pg_terminate${W}|pg_cancel${W}|pg_sleep${W}|pg_reload_conf|pg_rotate_logfile|pg_advisory${W}|pg_notify)"?\\s*\\(`,
  'i',
);
// Every unqualified pg_*() call is refused but these, which only read:
// replication slots, backups, WAL switches and statistics resets are all
// pg_* functions, and each Postgres version adds more.
const SQL_PG_CALL = new RegExp(`(?<![A-Za-z0-9_$])"?(pg_${W})"?\\s*\\(`, 'gi');
const SQL_PG_READS = [
  'pg_typeof',
  'pg_size_pretty',
  'pg_total_relation_size',
  'pg_relation_size',
  'pg_table_size',
  'pg_indexes_size',
  'pg_column_size',
];
const isPgRead = (name) =>
  SQL_PG_READS.includes(name) || name.startsWith('pg_get_');

// Any schema-qualified call but auth.uid() and auth.jwt(), the listed
// unqualified functions with side effects, and any pg_* function off the
// read list are refused.
function functionProblem(text, spans) {
  let t = text;
  for (const [a, b] of spans)
    t = t.slice(0, a) + ' '.repeat(b - a) + t.slice(b);
  for (const m of t.matchAll(SQL_QUALIFIED_CALL)) {
    if (!isReadOnlyCall(chainParts(m[0].replace(/\s*\($/, '')))) {
      return `a schema-qualified function call (only auth.uid() and auth.jwt() are allowed); ${REWORD}`;
    }
  }
  if (SQL_SIDE_EFFECT_CALL.test(t)) {
    return `a function with side effects; ${REWORD}`;
  }
  for (const m of t.matchAll(SQL_PG_CALL)) {
    if (!isPgRead(m[1].toLowerCase())) {
      return `a pg_* function off the read list (${SQL_PG_READS.join(', ')}, pg_get_*); ${REWORD}`;
    }
  }
  return null;
}
const REWORD =
  'reword the query (the check is plain text and counts strings and comments too)';

// A coarse text check on execute_sql, fail-closed. Every rule but the first
// word runs on the raw text and the comment-stripped text both, so a comment the
// stripper misreads can never hide anything.
export function sqlProblem(query) {
  if (typeof query !== 'string') return 'execute_sql needs a query string';
  // The checks below are regular expressions over the whole text; a very
  // long query could run the hook into its timeout.
  if (query.length > SQL_MAX_LENGTH) {
    return `a query over ${SQL_MAX_LENGTH} characters`;
  }
  // U&"…" spells any identifier with escapes, a refused function included.
  if (SQL_UNICODE_IDENT.test(query)) {
    return `a U&"…" identifier; ${REWORD}`;
  }
  const stripped = stripSqlComments(query);
  if (stripped === null) return 'an unclosed /* comment';
  const texts = [query, stripped];

  const semicolons = query.split(';').length - 1;
  if (semicolons > 1 || (semicolons === 1 && !stripped.trim().endsWith(';'))) {
    return `more than one statement (only one trailing ; is allowed); ${REWORD}`;
  }

  const first = /^[A-Za-z_]+(?![A-Za-z0-9_$])/.exec(stripped.trim())?.[0];
  if (!first || !SQL_FIRST_WORDS.includes(first.toLowerCase())) {
    return `the query must start with ${SQL_FIRST_WORDS.join(', ')}`;
  }

  for (const [w, re] of SQL_KEYWORDS) {
    const hit = (t) => re.test(w === 'do' ? t.replace(SQL_UPSERT_DO, ' ') : t);
    if (texts.some(hit)) return `the word "${w}"; ${REWORD}`;
  }

  for (const t of texts) {
    const { problem, spans } = writeTargets(t);
    if (problem) return problem;
    const fnProblem = functionProblem(t, spans);
    if (fnProblem) return fnProblem;
  }

  // Kept from the first pass as an extra layer: a write anywhere in the
  // statement may not name a system schema at all.
  if (texts.some((t) => SQL_WRITE.test(t))) {
    if (
      texts.some((t) => SQL_SYSTEM_SCHEMA.test(t) || SQL_UNICODE_IDENT.test(t))
    ) {
      return `a write naming a system schema (writes reach public tables only); ${REWORD}`;
    }
  }

  // SELECT ... INTO creates a table, a schema change.
  if (texts.some((t) => SQL_INTO.test(t.replace(SQL_INSERT_INTO, ' ')))) {
    return `INTO outside INSERT INTO (SELECT INTO creates a table); ${REWORD}`;
  }

  if (SQL_DOLLAR_QUOTE.test(query)) return `dollar quoting; ${REWORD}`;
  return null;
}

export function supabaseToolProblem(toolName, input, projectRef) {
  if (typeof toolName !== 'string' || !SUPABASE_TOOL.test(toolName))
    return null;
  const suffix = toolName.slice(toolName.lastIndexOf('__') + 2);
  if (SUPABASE_NO_PROJECT_TOOLS.includes(suffix)) return null;
  if (!Object.hasOwn(SUPABASE_REF_TOOLS, suffix)) {
    return `the tool ${suffix} is not on the allowlist`;
  }
  if (typeof projectRef !== 'string' || projectRef.length === 0) {
    return 'no project ref is committed in .claude/supabase-project.json';
  }
  const args = input && typeof input === 'object' ? input : {};
  const arg = SUPABASE_REF_TOOLS[suffix];
  if (args[arg] !== projectRef) {
    return `${arg} is not 10xapply's project`;
  }
  if (suffix === 'execute_sql') return sqlProblem(args.query);
  return null;
}

export function evaluate(
  { tool_name, tool_input = {} },
  {
    runnerName = RUNNER_NAME,
    safeSubcommands = RUNNER_SAFE_SUBCOMMANDS,
    supabaseProjectRef,
  } = {},
) {
  if (typeof tool_name === 'string' && tool_name.startsWith('mcp__')) {
    if (SUPABASE_TOOL.test(tool_name)) {
      const ref =
        supabaseProjectRef === undefined
          ? readSupabaseProjectRef()
          : supabaseProjectRef;
      const problem = supabaseToolProblem(tool_name, tool_input, ref);
      if (problem) {
        return {
          block: true,
          reason: `Supabase blocked: ${problem}. Claude may read and write rows in 10xapply's project only; the schema changes only through CI (see CLAUDE.md).`,
        };
      }
    }
  }

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
    const cliIssue = supabaseCliProblem(command);
    if (cliIssue === WORD_EXPANDED || cliIssue === WORD_SUBSTITUTED) {
      return {
        block: true,
        reason: `Command blocked: ${cliIssue} (see CLAUDE.md).`,
      };
    }
    if (cliIssue) {
      return {
        block: true,
        reason: `Supabase CLI blocked: ${cliIssue}. Claude may run the local stack only (see CLAUDE.md).`,
      };
    }
    if (remoteOptInProblem(command)) {
      return {
        block: true,
        reason: 'Remote database blocked: only CI sets XAPPLY_ALLOW_REMOTE_DB.',
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

// What the hook does with one event. A crash in the check must not let the
// call through: Claude Code treats any exit code but 2 as "go ahead", so a
// throw on a Bash or MCP call is turned into a refusal.
export function decide(event, check = evaluate) {
  try {
    return check(event ?? {});
  } catch (error) {
    const name = event?.tool_name;
    if (name === 'Bash' || (typeof name === 'string' && /^mcp__/.test(name))) {
      return {
        block: true,
        reason: `Blocked: the guard hook crashed on this call, so it is refused (${error?.message ?? error}). Fix .claude/hooks/guard.mjs or reword the call.`,
      };
    }
    return { block: false };
  }
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
  const result = decide(event);
  if (result.block) {
    console.error(result.reason);
    process.exit(2);
  }
}
