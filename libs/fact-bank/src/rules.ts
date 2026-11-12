import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { whereOf, type Problem } from './problems.js';
import { PLACEHOLDERS, type FactBankFile } from './schema.js';

const ALLOWED = new Set<string>(PLACEHOLDERS.map((p) => `{${p}}`));
const PLACEHOLDER_MESSAGE = `unknown placeholder (allowed: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')})`;

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function hasUnknownPlaceholder(text: string): boolean {
  return (text.match(/\{[^{}]*\}/g) ?? []).some((m) => !ALLOWED.has(m));
}

// Messages never quote file values: only positions and fixed text.
export function crossEntryProblems(file: FactBankFile): Problem[] {
  const problems: Problem[] = [];

  const ids = new Map<string, string>();
  for (const key of ['answers', 'stories'] as const) {
    file[key].forEach((entry, i) => {
      const first = ids.get(entry.id);
      if (first !== undefined) {
        problems.push({
          where: whereOf([key, i], file),
          message: `duplicate id, same as ${first}`,
        });
      } else {
        ids.set(entry.id, `${key}[${i}]`);
      }
    });
  }

  const facts = new Map<string, number>();
  file.facts.forEach((f, i) => {
    const key = normalize(typeof f === 'string' ? f : f.text);
    const first = facts.get(key);
    if (first !== undefined) {
      problems.push({
        where: `facts[${i}]`,
        message: `duplicate fact sentence, same as facts[${first}]`,
      });
    } else {
      facts.set(key, i);
    }
  });

  file.answers.forEach((a, i) => {
    if (a.answer !== undefined && hasUnknownPlaceholder(a.answer)) {
      problems.push({
        where: whereOf(['answers', i, 'answer'], file),
        message: PLACEHOLDER_MESSAGE,
      });
    }
    a.variants?.forEach((v, j) => {
      if (hasUnknownPlaceholder(v.answer)) {
        problems.push({
          where: whereOf(['answers', i, 'variants', j, 'answer'], file),
          message: PLACEHOLDER_MESSAGE,
        });
      }
    });
  });

  return problems;
}

export function resumeProblems(resume: string, baseDir: string): Problem[] {
  const where = 'fields.resume';
  const full = resolve(baseDir, resume);
  const rel = relative(resolve(baseDir), full);
  if (
    isAbsolute(resume) ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith('..' + '/') ||
    rel.startsWith('..\\') ||
    isAbsolute(rel)
  ) {
    return [{ where, message: "must be inside the bank's folder" }];
  }
  try {
    if (!statSync(full).isFile()) {
      return [{ where, message: 'file not found' }];
    }
  } catch {
    return [{ where, message: 'file not found' }];
  }
  try {
    const fd = openSync(full, 'r');
    try {
      const buf = Buffer.alloc(5);
      const n = readSync(fd, buf, 0, 5, 0);
      if (n < 5 || buf.toString('latin1') !== '%PDF-') {
        return [{ where, message: 'is not a PDF' }];
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return [{ where, message: 'could not be read' }];
  }
  return [];
}
