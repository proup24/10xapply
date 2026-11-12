import type { z } from 'zod';
import { ID_PATTERN } from './schema.js';

export interface Problem {
  where: string;
  message: string;
}

export function formatProblem(p: Problem): string {
  return `${p.where}: ${p.message}`;
}

type Path = (string | number)[];
type Issue = z.core.$ZodIssue;

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/;

const FORMAT_MESSAGES: Record<string, string> = {
  'format:email': 'must be an email address',
  'format:country-code': 'must start with + and digits',
  'format:digits': 'must be digits only',
  'format:https': 'must start with https://',
  'format:date': 'must be a date written YYYY-MM-DD',
  'format:kebab': 'must be kebab-case',
  'one-of-answer-variants': 'needs exactly one of answer or variants',
};

const NOT_VALID = 'is not valid';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function valueAt(raw: unknown, path: Path): { found: boolean; value: unknown } {
  let cur: unknown = raw;
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === 'number') {
      if (seg >= cur.length) return { found: false, value: undefined };
      cur = cur[seg];
    } else if (isObject(cur) && typeof seg === 'string') {
      if (!Object.hasOwn(cur, seg)) return { found: false, value: undefined };
      cur = cur[seg];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

export function whereOf(path: Path, raw: unknown): string {
  if (path.length === 0) return '(top level)';
  let out = '';
  let cur: unknown = raw;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (typeof seg === 'number') {
      out += `[${seg}]`;
      cur = Array.isArray(cur) ? cur[seg] : undefined;
      const parent = path[i - 1];
      if (parent === 'answers' || parent === 'stories') {
        const id = isObject(cur) ? cur['id'] : undefined;
        if (typeof id === 'string' && ID_PATTERN.test(id)) {
          out += ` (id: ${id})`;
        }
      }
    } else {
      out += out === '' ? seg : `.${seg}`;
      cur = isObject(cur) ? cur[seg] : undefined;
    }
  }
  return out;
}

function typeWords(expected: unknown): string {
  switch (expected) {
    case 'string':
      return 'a text value';
    case 'array':
      return 'a list';
    case 'object':
    case 'record':
      return 'a mapping';
    case 'number':
    case 'int':
      return 'a number';
    case 'boolean':
      return 'true or false';
    default:
      return 'a different kind of value';
  }
}

// Issues from one union branch, with paths made absolute.
function absolute(issue: Issue, base: Path): Issue {
  const p = issue.path as Path;
  const hasBase = base.every((s, i) => p[i] === s);
  return hasBase ? issue : ({ ...issue, path: [...base, ...p] } as Issue);
}

function flatten(issues: readonly Issue[], raw: unknown): Issue[] {
  const out: Issue[] = [];
  for (const issue of issues) {
    if (issue.code !== 'invalid_union') {
      out.push(issue);
      continue;
    }
    const base = issue.path as Path;
    const here = valueAt(raw, base).value;
    const branches = (issue.errors as Issue[][]).map((b) =>
      b.map((i) => absolute(i, base)),
    );
    // A branch "matches the shape" when it does not fail on the input's own type.
    const shaped = branches.filter(
      (b) =>
        b.length > 0 &&
        !b.some(
          (i) =>
            i.code === 'invalid_type' &&
            (i.path as Path).length === base.length,
        ),
    );
    if (isObject(here) && shaped.length === 1) {
      out.push(...flatten(shaped[0], raw));
    } else {
      out.push(issue);
    }
  }
  return out;
}

function isEmptyString(issue: Issue): boolean {
  return (
    issue.code === 'too_small' &&
    issue.origin === 'string' &&
    Number(issue.minimum) === 1
  );
}

function problemFor(issue: Issue, raw: unknown): Problem[] {
  const path = issue.path as Path;
  const where = whereOf(path, raw);
  // The issue's own text is only ever used as a lookup key, never shown.
  const known = Object.hasOwn(FORMAT_MESSAGES, issue.message)
    ? FORMAT_MESSAGES[issue.message]
    : undefined;
  if (known !== undefined) return [{ where, message: known }];

  switch (issue.code) {
    case 'invalid_type': {
      const { found, value } = valueAt(raw, path);
      if (!found || value === undefined) {
        return [{ where, message: 'is required' }];
      }
      if (issue.expected === 'array') {
        return [{ where, message: 'must be a list (write [] for none)' }];
      }
      return [{ where, message: `must be ${typeWords(issue.expected)}` }];
    }
    case 'too_small':
      if (isEmptyString(issue))
        return [{ where, message: 'must not be empty' }];
      return [{ where, message: NOT_VALID }];
    case 'unrecognized_keys':
      return (issue.keys as string[]).map((k) => ({
        where,
        message: SAFE_KEY.test(k) ? `unknown key \`${k}\`` : 'unknown key',
      }));
    default:
      return [{ where, message: NOT_VALID }];
  }
}

export function problemsFromZod(error: z.ZodError, raw: unknown): Problem[] {
  const issues = flatten(error.issues as Issue[], raw);
  // An empty value also fails every later check on it; say it once.
  const empty = new Set(
    issues.filter(isEmptyString).map((i) => JSON.stringify(i.path)),
  );
  return issues
    .filter((i) => isEmptyString(i) || !empty.has(JSON.stringify(i.path)))
    .flatMap((i) => problemFor(i, raw));
}
