import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ISO_CODES } from './countries.js';
import { DEFAULT_RULES_PATH } from './paths.js';

export { DEFAULT_RULES_PATH };

export interface Rules {
  /** Upper-case ISO 3166-1 alpha-2 codes, at least one, no regions. */
  authorizedCountries: string[];
}

export interface RulesCheck {
  ok: boolean;
  path: string;
  counts: { authorizedCountries: number };
  problems: string[];
  rules?: Rules;
}

export class RulesError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The rules file has problems: ${problems.join('; ')}`);
    this.name = 'RulesError';
    this.problems = problems;
  }
}

// Messages are fixed text. The schema's own messages are never shown, because
// they can quote the file.
const BAD_CODE = 'not-a-country-code';
const schema = z.strictObject({
  authorizedCountries: z
    .array(
      z
        .string()
        .transform((s) => s.trim().toUpperCase())
        .refine((s) => ISO_CODES.has(s), { message: BAD_CODE }),
    )
    .min(1),
});

type Path = PropertyKey[];

function where(path: Path): string {
  if (path.length === 0) return '(top level)';
  let out = '';
  for (const seg of path) {
    out +=
      typeof seg === 'number'
        ? `[${seg}]`
        : out === ''
          ? String(seg)
          : `.${String(seg)}`;
  }
  return out;
}

function problemsOf(error: z.ZodError, raw: unknown): string[] {
  const out: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path as Path;
    const at = where(path);
    if (issue.code === 'unrecognized_keys') {
      for (let i = 0; i < issue.keys.length; i++)
        out.push(`${at}: unknown key`);
    } else if (issue.code === 'too_small') {
      out.push(`${at}: needs at least one country code`);
    } else if (issue.code === 'invalid_type') {
      const missing =
        raw !== null &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        path.length === 1 &&
        !Object.hasOwn(raw, path[0] as string);
      out.push(
        `${at}: ${
          missing
            ? 'is required'
            : issue.expected === 'array'
              ? 'must be a list of country codes'
              : issue.expected === 'object'
                ? 'must be a mapping'
                : 'must be a text value'
        }`,
      );
    } else if (issue.message === BAD_CODE) {
      out.push(`${at}: is not a country code`);
    } else {
      out.push(`${at}: is not valid`);
    }
  }
  return out;
}

export function checkRules(path: string = DEFAULT_RULES_PATH): RulesCheck {
  const result: RulesCheck = {
    ok: false,
    path,
    counts: { authorizedCountries: 0 },
    problems: [],
  };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    result.problems.push(
      `file: ${missing ? 'not found' : 'could not be read'}`,
    );
    return result;
  }

  // logLevel 'error' keeps the parser from printing warnings that can quote
  // the file. failsafe keeps every scalar a string.
  const doc = parseDocument(
    text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    {
      schema: 'failsafe',
      uniqueKeys: true,
      logLevel: 'error',
    },
  );
  const first = doc.errors[0];
  if (first) {
    // Only the position; the parser's message can quote the file.
    const pos = first.linePos?.[0];
    result.problems.push(
      `${pos ? `line ${pos.line}, column ${pos.col}` : 'file'}: YAML syntax error`,
    );
    return result;
  }

  const raw: unknown = doc.toJS() ?? undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    result.problems.push(...problemsOf(parsed.error, raw));
    if (result.problems.length === 0)
      result.problems.push('file: is not valid');
    return result;
  }

  const rules: Rules = {
    authorizedCountries: [...new Set(parsed.data.authorizedCountries)],
  };
  result.ok = true;
  result.rules = rules;
  result.counts.authorizedCountries = rules.authorizedCountries.length;
  return result;
}

export function loadRules(path: string = DEFAULT_RULES_PATH): Rules {
  const r = checkRules(path);
  if (!r.ok || !r.rules) throw new RulesError(r.problems);
  return r.rules;
}
