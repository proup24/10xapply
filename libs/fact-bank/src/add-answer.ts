import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
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

function withPlaceholder(
  text: string,
  value: string | null,
  token: string,
): string {
  if (value === null || value.trim().length < MIN_REPLACE_LENGTH) return text;
  return text.replace(new RegExp(escapeRegExp(value.trim()), 'gi'), token);
}

function fill(text: string, company: string | null, jobTitle: string | null) {
  return withPlaceholder(
    withPlaceholder(text, company, '{company}'),
    jobTitle,
    '{jobTitle}',
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
  try {
    copyFileSync(path, backup);
  } catch {
    return { ok: false, problems: ['file: could not be backed up'] };
  }

  const restore = (problems: string[]): AddAnswerResult => {
    try {
      copyFileSync(backup, path);
    } catch {
      problems.push('file: could not be restored from the backup');
    }
    return { ok: false, problems };
  };

  try {
    const doc = parseDocument(readFileSync(path, 'utf8'));
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      return restore(['file: is not valid YAML']);
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
    const id = answerIdFrom(entry.question, taken);
    const node = doc.createNode({
      id,
      question: fill(entry.question, opts.company, opts.jobTitle),
      answer: fill(entry.answer, opts.company, opts.jobTitle),
      confirmed: opts.today,
    });
    let answers = doc.get('answers');
    if (!isSeq(answers)) {
      answers = new YAMLSeq();
      doc.set('answers', answers);
    }
    (answers as YAMLSeq).add(node);
    writeFileSync(path, doc.toString());

    const check = checkFactBank(path);
    if (!check.ok) return restore(check.errors.map(formatProblem));
    return { ok: true, id };
  } catch {
    return restore(['file: could not be updated']);
  }
}
