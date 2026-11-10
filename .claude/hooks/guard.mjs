import { pathToFileURL } from 'node:url';

const segments = (p) => p.split('/');
const isSecret = (s) =>
  s === '.env' || (s.startsWith('.env.') && s !== '.env.example');
const isPrivate = (s) => s === 'private';

const pathHit = (p) => segments(p).some((s) => isSecret(s) || isPrivate(s));
// Globs can match a secret through a wildcard such as `.env*`.
const globHit = (p) =>
  segments(p).some((s) => s.startsWith('.env') && s !== '.env.example') ||
  segments(p).some(isPrivate);

// Bash expands wildcards itself, so `.env*` must count as a secret too.
const bashHit = (t) =>
  pathHit(t) ||
  segments(t).some((s) => s.startsWith('.env') && /[*?[{]/.test(s));

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
  reason: `Blocked: ${p} is a secret or private file (see CLAUDE.md).`,
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
    if (tokens[i++] !== 'git') continue;
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

// The value of a flag given as `--name value`, `--name=value` or `-Xvalue`.
function flagValue(args, long, short) {
  let value;
  args.forEach((a, j) => {
    if (a === `--${long}` || a === `-${short}`) value = args[j + 1] ?? '';
    else if (a.startsWith(`--${long}=`)) value = a.slice(long.length + 3);
    else if (!a.startsWith('--') && a.startsWith(`-${short}`)) {
      value = a.slice(short.length + 1);
    }
  });
  return value;
}

function ghApiProblem(args) {
  const method = flagValue(args, 'method', 'X');
  const writes = args.some((a) => GH_API_BODY_FLAGS.test(a));
  const effective = (method ?? (writes ? 'POST' : 'GET')).toUpperCase();
  return effective === 'GET' ? null : 'gh api write calls are not allowed';
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
    if (tokens[i] !== 'gh') continue;
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
    if (words[0] !== 'pr') continue;
    if (words[1] === 'merge') return 'merging is for the human';
    const base = flagValue(args, 'base', 'B');
    if (words[1] === 'edit' && base !== undefined) {
      return 'retargeting a PR is not allowed';
    }
    if (
      words[1] === 'review' &&
      args.some((a) => a === '--approve' || a === '-a')
    ) {
      return 'approving a PR is not allowed';
    }
    if (words[1] === 'create' && base !== undefined && base !== 'main') {
      return 'PRs may only target main';
    }
  }
  return null;
}

// Returns the first secret or private token, looking inside nested shells.
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

export function evaluate({ tool_name, tool_input = {} }) {
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
    const hit = findBlockedToken(command);
    if (hit) return blockPath(hit);
    return { block: false };
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
