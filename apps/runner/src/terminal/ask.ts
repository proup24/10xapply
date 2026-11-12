import type { AnswerValue, FormQuestion } from '@xapply/answerer';
import { toTypeable } from '../apply/typeable.js';
import type { TerminalIO } from './author-mode.js';

export type AuthorReply =
  { kind: 'answer'; value: AnswerValue } | { kind: 'blank' } | { kind: 'stop' };

const CHOICE = new Set(['select', 'radio', 'checkbox-group', 'checkbox']);
const CHECKBOX_OPTIONS = ['Yes', 'No'];

/**
 * Asks the author to answer a blocked question at the terminal. Author mode
 * only: it prints the label, options and help text to `io`.
 */
export async function askBlocked(
  io: TerminalIO,
  q: FormQuestion,
  stepTitle: string | null,
  why: string,
): Promise<AuthorReply> {
  const choice = CHOICE.has(q.type);
  const options =
    q.type === 'checkbox' ? CHECKBOX_OPTIONS : choice ? (q.options ?? []) : [];
  const many = q.type === 'checkbox-group';

  io.print('');
  io.print(`Blocked question${stepTitle ? ` on "${stepTitle}"` : ''}`);
  io.print(`  ${q.label}`);
  io.print(`  type: ${q.type}${q.required ? ', required' : ', optional'}`);
  if (q.helpText) io.print(`  help: ${q.helpText}`);
  io.print(`  why: ${why}`);
  options.forEach((o, i) => io.print(`  ${i + 1}. ${o}`));

  const what = choice
    ? many
      ? 'option numbers, comma-separated'
      : 'an option number'
    : 'your answer';
  const prompt = `Type ${what}${q.required ? '' : ', b to leave blank'}, or s to stop: `;

  for (;;) {
    const raw = await io.ask(prompt);
    const line = raw.trim();
    const word = line.toLowerCase();
    if (word === 's') return { kind: 'stop' };
    if (word === 'b') {
      if (!q.required) return { kind: 'blank' };
      io.print('This question is required; it cannot be left blank.');
      continue;
    }
    if (choice) {
      const picked = parseNumbers(line, options.length, many);
      if (picked === null) {
        io.print(
          many
            ? `Enter numbers from 1 to ${options.length}, separated by commas.`
            : `Enter one number from 1 to ${options.length}.`,
        );
        continue;
      }
      const texts = picked.map((n) => options[n - 1] ?? '');
      return { kind: 'answer', value: many ? texts : (texts[0] ?? '') };
    }
    if (line === '') {
      io.print('Type an answer, or s to stop.');
      continue;
    }
    if (toTypeable(line) === null) {
      io.print('That has a character the runner cannot type; use plain ASCII.');
      continue;
    }
    return { kind: 'answer', value: line };
  }
}

/** 1-based option numbers, deduplicated in the order given, or null. */
function parseNumbers(
  line: string,
  count: number,
  many: boolean,
): number[] | null {
  const parts = line.split(',').map((p) => p.trim());
  if (!many && parts.length !== 1) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 1 || n > count) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : null;
}

/** Asks whether to save the author's answer; an empty reply means yes. */
export async function askSave(io: TerminalIO): Promise<boolean> {
  for (;;) {
    const word = (await io.ask('Save to the fact bank? [Y/n] '))
      .trim()
      .toLowerCase();
    if (word === '' || word === 'y' || word === 'yes') return true;
    if (word === 'n' || word === 'no') return false;
    io.print('Answer y or n.');
  }
}
