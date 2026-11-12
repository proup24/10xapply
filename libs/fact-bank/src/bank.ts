import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_FACT_BANK_PATH } from './paths.js';
import { formatProblem, problemsFromZod, type Problem } from './problems.js';
import { readYaml } from './read.js';
import { crossEntryProblems, resumeProblems } from './rules.js';
import { factBankSchema, type FactBankFile } from './schema.js';

export { DEFAULT_FACT_BANK_PATH };
export const SIZE_WARNING_CHARACTERS = 60_000;

export interface Fact {
  text: string;
  tags: string[];
  confirmed?: string;
}

type RawAnswer = FactBankFile['answers'][number];
type RawVariant = NonNullable<RawAnswer['variants']>[number];
type RawStory = FactBankFile['stories'][number];

export type Variant = Omit<RawVariant, 'tags'> & { tags: string[] };
export type Story = Omit<RawStory, 'tags'> & { tags: string[] };
// Exactly one of answer or variants, as the file rule requires.
export type Answer = Omit<RawAnswer, 'answer' | 'variants' | 'tags'> & {
  tags: string[];
} & (
    | { answer: string; variants?: never }
    | { variants: [Variant, ...Variant[]]; answer?: never }
  );

export interface FactBank extends Omit<
  FactBankFile,
  'facts' | 'fields' | 'answers' | 'stories'
> {
  facts: Fact[];
  answers: Answer[];
  stories: Story[];
  fields: Omit<FactBankFile['fields'], 'phone'> & {
    phone: FactBankFile['fields']['phone'] & { full: string };
    fullName: string;
    location: string;
  };
}

export interface CheckResult {
  path: string;
  ok: boolean;
  counts: { facts: number; answers: number; stories: number };
  size: { characters: number; tokens: number };
  warnings: Problem[];
  errors: Problem[];
  bank?: FactBank;
}

export class FactBankError extends Error {
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map(formatProblem).join('\n'));
    this.name = 'FactBankError';
    this.problems = problems;
  }
}

function buildAnswer(a: RawAnswer): Answer {
  const { answer, variants, tags, ...rest } = a;
  const base = { ...rest, tags: tags ?? [] };
  if (variants !== undefined) {
    return {
      ...base,
      variants: variants.map((v) => ({ ...v, tags: v.tags ?? [] })) as [
        Variant,
        ...Variant[],
      ],
    };
  }
  // The file rule guarantees answer is set when variants is not.
  return { ...base, answer: answer as string };
}

function build(file: FactBankFile, baseDir: string): FactBank {
  const f = file.fields;
  const number = f.phone.number.replace(/ /g, '');
  return {
    ...file,
    facts: file.facts.map((x): Fact => {
      if (typeof x === 'string') return { text: x, tags: [] };
      const fact: Fact = { text: x.text, tags: x.tags ?? [] };
      if (x.confirmed !== undefined) fact.confirmed = x.confirmed;
      return fact;
    }),
    answers: file.answers.map(buildAnswer),
    stories: file.stories.map((x) => ({ ...x, tags: x.tags ?? [] })),
    fields: {
      ...f,
      phone: { ...f.phone, number, full: `${f.phone.countryCode} ${number}` },
      resume: resolve(baseDir, f.resume),
      fullName: `${f.firstName} ${f.lastName}`,
      location: `${f.city}, ${f.country}`,
    },
  };
}

export function checkFactBank(
  path: string = DEFAULT_FACT_BANK_PATH,
): CheckResult {
  const result: CheckResult = {
    path,
    ok: false,
    counts: { facts: 0, answers: 0, stories: 0 },
    size: { characters: 0, tokens: 0 },
    warnings: [],
    errors: [],
  };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    result.errors.push({
      where: 'file',
      message: missing ? 'not found' : 'could not be read',
    });
    return result;
  }
  // Counted as read, before any BOM is stripped.
  result.size = { characters: text.length, tokens: Math.ceil(text.length / 4) };

  const read = readYaml(text);
  if (read.problems.length > 0) {
    result.errors = read.problems;
    return result;
  }

  const parsed = factBankSchema.safeParse(read.raw);
  if (!parsed.success) {
    result.errors = problemsFromZod(parsed.error, read.raw);
    return result;
  }
  const file = parsed.data;
  result.counts = {
    facts: file.facts.length,
    answers: file.answers.length,
    stories: file.stories.length,
  };

  const baseDir = dirname(resolve(path));
  result.errors = [
    ...crossEntryProblems(file),
    ...resumeProblems(file.fields.resume, baseDir),
  ];
  if (result.errors.length > 0) return result;

  if (text.length > SIZE_WARNING_CHARACTERS) {
    result.warnings.push({
      where: 'file',
      message: `is large (over ${SIZE_WARNING_CHARACTERS} characters); every answer call sends the whole file`,
    });
  }
  result.ok = true;
  result.bank = build(file, baseDir);
  return result;
}

export function loadFactBank(path: string = DEFAULT_FACT_BANK_PATH): FactBank {
  const r = checkFactBank(path);
  if (!r.ok || !r.bank) throw new FactBankError(r.errors);
  return r.bank;
}
