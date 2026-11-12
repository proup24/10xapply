import {
  chmodSync,
  constants,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isMap, isSeq, parseDocument, YAMLSeq } from 'yaml';
import { checkFactBank } from './bank.js';
import { formatProblem } from './problems.js';

const MAX_WORDS = 6;
const MIN_REPLACE_LENGTH = 3;

// Kebab-case of the label, digits removed, first 6 words, -2, -3, ... when
// taken, and "answer" when nothing is left.
export function answerIdFrom(
  label: string,
  taken: ReadonlySet<string>,
): string {
  const words = label
    .toLowerCase()
    .replace(/[0-9]/g, '')
    .split(/[^a-z]+/)
    .filter((w) => w !== '')
    .slice(0, MAX_WORDS);
  const base = words.length > 0 ? words.join('-') : 'answer';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One combined pass, whole occurrences only, longer value first, so a value
// can never match inside a token inserted by the other.
function substituter(company: string | null, jobTitle: string | null) {
  const usable = (v: string | null) =>
    v !== null && v.trim().length >= MIN_REPLACE_LENGTH ? v.trim() : null;
  const c = usable(company);
  const j = usable(jobTitle);
  const values = [c, j]
    .filter((v): v is string => v !== null)
    .sort((x, y) => y.length - x.length);
  if (values.length === 0) return (text: string) => text;
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${values.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  return (text: string) =>
    text.replace(re, (m) =>
      c !== null && m.toLowerCase() === c.toLowerCase()
        ? '{company}'
        : '{jobTitle}',
    );
}

export type AddAnswerResult =
  { ok: true; id: string } | { ok: false; problems: string[] };

export function addKnownAnswer(
  path: string,
  entry: { question: string; answer: string },
  opts: {
    company: string | null;
    jobTitle: string | null;
    today: string;
    stamp: string;
  },
): AddAnswerResult {
  const backup = `${path}.${opts.stamp}.bak`;
  const temp = `${path}.${opts.stamp}.tmp`;
  try {
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
  } catch {
    return { ok: false, problems: ['file: could not be backed up'] };
  }

  try {
    const doc = parseDocument(readFileSync(path, 'utf8'));
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      return { ok: false, problems: ['file: is not valid YAML'] };
    }
    const taken = new Set<string>();
    for (const key of ['answers', 'stories']) {
      const seq = doc.get(key);
      if (!isSeq(seq)) continue;
      for (const item of seq.items) {
        const id = isMap(item) ? item.get('id') : undefined;
        if (typeof id === 'string') taken.add(id);
      }
    }
    const sub = substituter(opts.company, opts.jobTitle);
    const question = sub(entry.question);
    const id = answerIdFrom(question, taken);
    const node = doc.createNode({
      id,
      question,
      answer: sub(entry.answer),
      confirmed: opts.today,
    });
    let answers = doc.get('answers');
    if (!isSeq(answers)) {
      answers = new YAMLSeq();
      doc.set('answers', answers);
    }
    (answers as YAMLSeq).add(node);

    const mode = statSync(path).mode & 0o777;
    writeFileSync(
      temp,
      doc.toString({ lineWidth: 0, flowCollectionPadding: false }),
      { mode },
    );
    chmodSync(temp, mode);

    const check = checkFactBank(temp);
    if (!check.ok) {
      rmSync(temp, { force: true });
      return { ok: false, problems: check.errors.map(formatProblem) };
    }
    renameSync(temp, path);
    return { ok: true, id };
  } catch (e) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // nothing more to do; the bank itself was never touched
    }
    const code = (e as NodeJS.ErrnoException)?.code;
    const name = e instanceof Error ? e.name : 'error';
    return {
      ok: false,
      problems: [`file: could not be updated (${code ?? name})`],
    };
  }
}
