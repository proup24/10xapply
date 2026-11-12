import { describe, expect, it } from 'vitest';
import { crossEntryProblems } from './rules.js';
import { validFile } from './testing/valid-file.js';
import type { FactBankFile } from './schema.js';

function file(change: (f: ReturnType<typeof validFile>) => void): FactBankFile {
  const f = validFile();
  change(f);
  return f as FactBankFile;
}

describe('crossEntryProblems', () => {
  it('passes a valid file', () => {
    expect(crossEntryProblems(file(() => undefined))).toEqual([]);
  });

  it('flags a duplicate id across an answer and a story', () => {
    const f = file((x) => {
      x['stories'][0].id = 'contractor-rate';
    });
    expect(crossEntryProblems(f)).toEqual([
      {
        where: 'stories[0] (id: contractor-rate)',
        message: 'duplicate id, same as answers[1]',
      },
    ]);
  });

  it('flags a duplicate fact after trim and whitespace collapse', () => {
    const f = file((x) => {
      x['facts'] = ['I am a citizen.', { text: '  I am   a\tcitizen. ' }];
    });
    expect(crossEntryProblems(f)).toEqual([
      {
        where: 'facts[1]',
        message: 'duplicate fact sentence, same as facts[0]',
      },
    ]);
  });

  it('compares facts case-sensitively', () => {
    const f = file((x) => {
      x['facts'] = ['I am a citizen.', 'i am a citizen.'];
    });
    expect(crossEntryProblems(f)).toEqual([]);
  });

  it('rejects spaced or miscased placeholders and accepts the exact ones', () => {
    const bad = (answer: string) =>
      crossEntryProblems(
        file((x) => {
          x['answers'][0].answer = answer;
        }),
      );
    expect(bad('{source}')).toEqual([]);
    expect(bad('{company} {jobTitle}')).toEqual([]);
    for (const a of ['{ source }', '{Source}']) {
      expect(bad(a)).toEqual([
        {
          where: 'answers[0] (id: notice-period).answer',
          message:
            'unknown placeholder (allowed: {source}, {company}, {jobTitle})',
        },
      ]);
    }
  });

  it('checks variant answers and never quotes the text', () => {
    const f = file((x) => {
      x['answers'][1].variants[0].answer = 'secret {oops}';
    });
    const p = crossEntryProblems(f);
    expect(p).toHaveLength(1);
    expect(p[0].where).toBe(
      'answers[1] (id: contractor-rate).variants[0].answer',
    );
    expect(JSON.stringify(p)).not.toContain('oops');
  });

  it('ignores braces in stories', () => {
    const f = file((x) => {
      x['stories'][0].story = 'I used {x} here.';
    });
    expect(crossEntryProblems(f)).toEqual([]);
  });
});
