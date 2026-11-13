import { describe, expect, it } from 'vitest';
import type { FormQuestion } from '@xapply/answerer';
import type { TerminalIO } from './author-mode.js';
import { askBlocked, askSave } from './ask.js';

function fakeIO(replies: string[]) {
  const printed: string[] = [];
  const prompts: string[] = [];
  const io: TerminalIO = {
    print: (line) => void printed.push(line),
    ask: async (prompt) => {
      prompts.push(prompt);
      const next = replies.shift();
      if (next === undefined) throw new Error('no more replies');
      return next;
    },
  };
  return { io, printed, prompts };
}

const q = (over: Partial<FormQuestion>): FormQuestion => ({
  id: 's1-q1',
  label: 'Label',
  type: 'text',
  required: true,
  ...over,
});

describe('askBlocked', () => {
  it('prints the step title, label, type, help, why and numbered options', async () => {
    const { io, printed } = fakeIO(['1']);
    await askBlocked(
      io,
      q({
        label: 'Visa?',
        type: 'radio',
        options: ['Yes', 'No'],
        helpText: 'Be honest',
      }),
      'Work authorization',
      'bank-silent',
    );
    const text = printed.join('\n');
    expect(text).toContain('Work authorization');
    expect(text).toContain('Visa?');
    expect(text).toContain('radio');
    expect(text).toContain('Be honest');
    expect(text).toContain('bank-silent');
    expect(text).toContain('1. Yes');
    expect(text).toContain('2. No');
  });

  it('takes the typed line for a text field', async () => {
    const { io } = fakeIO(['  Ada Lovelace ']);
    expect(await askBlocked(io, q({}), null, 'why')).toEqual({
      kind: 'answer',
      value: 'Ada Lovelace',
    });
  });

  it('asks again for a text answer it could not type', async () => {
    const { io, prompts } = fakeIO(['café', 'cafe']);
    expect(await askBlocked(io, q({}), null, 'why')).toEqual({
      kind: 'answer',
      value: 'cafe',
    });
    expect(prompts).toHaveLength(2);
  });

  it('asks again for an empty text answer', async () => {
    const { io, prompts } = fakeIO(['', 'x']);
    expect(await askBlocked(io, q({}), null, 'why')).toEqual({
      kind: 'answer',
      value: 'x',
    });
    expect(prompts).toHaveLength(2);
  });

  it('parses one number for a radio into the option text', async () => {
    const { io } = fakeIO([' 2 ']);
    const reply = await askBlocked(
      io,
      q({ type: 'radio', options: ['Yes', 'No'] }),
      null,
      'why',
    );
    expect(reply).toEqual({ kind: 'answer', value: 'No' });
  });

  it('asks again on a radio number out of range or several numbers', async () => {
    const { io, prompts } = fakeIO(['3', '1,2', 'x', '1']);
    const reply = await askBlocked(
      io,
      q({ type: 'radio', options: ['Yes', 'No'] }),
      null,
      'why',
    );
    expect(reply).toEqual({ kind: 'answer', value: 'Yes' });
    expect(prompts).toHaveLength(4);
  });

  it('parses comma-separated numbers for a checkbox group', async () => {
    const { io } = fakeIO([' 3, 1 ,3']);
    const reply = await askBlocked(
      io,
      q({ type: 'checkbox-group', options: ['A', 'B', 'C'] }),
      null,
      'why',
    );
    expect(reply).toEqual({ kind: 'answer', value: ['C', 'A'] });
  });

  it('asks again on a bad checkbox-group list', async () => {
    const { io, prompts } = fakeIO(['1,,2', '0', '1,4', '2']);
    const reply = await askBlocked(
      io,
      q({ type: 'checkbox-group', options: ['A', 'B', 'C'] }),
      null,
      'why',
    );
    expect(reply).toEqual({ kind: 'answer', value: ['B'] });
    expect(prompts).toHaveLength(4);
  });

  it('parses a select number into a string', async () => {
    const { io } = fakeIO(['1']);
    const reply = await askBlocked(
      io,
      q({ type: 'select', options: ['a@x.io'] }),
      null,
      'why',
    );
    expect(reply).toEqual({ kind: 'answer', value: 'a@x.io' });
  });

  it('offers Yes and No for a checkbox', async () => {
    const { io, printed } = fakeIO(['2']);
    const reply = await askBlocked(io, q({ type: 'checkbox' }), null, 'why');
    expect(printed.join('\n')).toContain('1. Yes');
    expect(printed.join('\n')).toContain('2. No');
    expect(reply).toEqual({ kind: 'answer', value: 'No' });
  });

  it('b refused on a required question', async () => {
    const { io, prompts, printed } = fakeIO(['b', 'x']);
    const reply = await askBlocked(io, q({ required: true }), null, 'why');
    expect(reply).toEqual({ kind: 'answer', value: 'x' });
    expect(prompts).toHaveLength(2);
    expect(printed.join('\n')).toMatch(/required/i);
  });

  it('b leaves an optional question blank, in any case', async () => {
    const { io } = fakeIO([' B ']);
    expect(await askBlocked(io, q({ required: false }), null, 'why')).toEqual({
      kind: 'blank',
    });
  });

  it('s stops, in any case', async () => {
    const { io } = fakeIO([' S']);
    expect(
      await askBlocked(io, q({ type: 'radio', options: ['A'] }), null, 'why'),
    ).toEqual({ kind: 'stop' });
  });

  it('does not offer blank on a required question', async () => {
    const { io, prompts } = fakeIO(['s']);
    await askBlocked(io, q({ required: true }), null, 'why');
    expect(prompts[0]).not.toMatch(/blank/);
  });
});

describe('askSave', () => {
  it('asks the save question', async () => {
    const { io, prompts } = fakeIO(['']);
    await askSave(io);
    expect(prompts[0]).toBe('Save to the fact bank? [Y/n] ');
  });

  it('empty reply means yes', async () => {
    expect(await askSave(fakeIO(['']).io)).toBe(true);
  });

  it('y and n in any case', async () => {
    expect(await askSave(fakeIO([' Y ']).io)).toBe(true);
    expect(await askSave(fakeIO(['yes']).io)).toBe(true);
    expect(await askSave(fakeIO(['N']).io)).toBe(false);
    expect(await askSave(fakeIO(['no']).io)).toBe(false);
  });

  it('asks again on anything else', async () => {
    const { io, prompts } = fakeIO(['maybe', 'n']);
    expect(await askSave(io)).toBe(false);
    expect(prompts).toHaveLength(2);
  });
});
