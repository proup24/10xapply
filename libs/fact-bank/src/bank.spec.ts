import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  checkFactBank,
  DEFAULT_FACT_BANK_PATH,
  FactBankError,
  loadFactBank,
  SIZE_WARNING_CHARACTERS,
} from './bank.js';
import { validFile } from './testing/valid-file.js';

function setup(
  change: (f: ReturnType<typeof validFile>) => void = () => undefined,
  resume: string | null = '%PDF-1.4\n%%EOF\n',
) {
  const dir = mkdtempSync(join(tmpdir(), 'fact-bank-'));
  if (resume !== null) writeFileSync(join(dir, 'resume.pdf'), resume);
  const f = validFile();
  change(f);
  const path = join(dir, 'bank.yaml');
  const text = stringify(f);
  writeFileSync(path, text);
  return { dir, path, text };
}

describe('checkFactBank', () => {
  it('accepts a valid file and derives fields', () => {
    const { path, text, dir } = setup();
    const r = checkFactBank(path);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counts).toEqual({ facts: 2, answers: 2, stories: 1 });
    expect(r.size.characters).toBe(text.length);
    expect(r.size.tokens).toBe(Math.ceil(text.length / 4));
    expect(r.warnings).toEqual([]);
    const b = r.bank;
    if (!b) throw new Error('no bank');
    expect(b.fields.fullName).toBe('Sam Example');
    expect(b.fields.location).toBe('Leeds, United Kingdom');
    expect(b.fields.phone.number).toBe('7700900123');
    expect(b.fields.phone.full).toBe('+44 7700900123');
    expect(b.facts[0]).toEqual({ text: 'I am a British citizen.', tags: [] });
    expect(isAbsolute(b.fields.resume)).toBe(true);
    expect(b.fields.resume).toBe(join(dir, 'resume.pdf'));
  });

  it('rejects a resume outside the folder', () => {
    const { path } = setup((f) => {
      f['fields'].resume = '../resume.pdf';
    });
    expect(checkFactBank(path).errors).toEqual([
      { where: 'fields.resume', message: "must be inside the bank's folder" },
    ]);
  });

  it('rejects a missing resume', () => {
    const { path } = setup(undefined, null);
    expect(checkFactBank(path).errors).toEqual([
      { where: 'fields.resume', message: 'file not found' },
    ]);
  });

  it('rejects a resume that is not a PDF', () => {
    const { path } = setup(undefined, 'hello world');
    expect(checkFactBank(path).errors).toEqual([
      { where: 'fields.resume', message: 'is not a PDF' },
    ]);
  });

  it('warns on a large file but stays ok', () => {
    const { path } = setup((f) => {
      f['facts'].push('x'.repeat(SIZE_WARNING_CHARACTERS));
    });
    const r = checkFactBank(path);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].where).toBe('file');
  });

  it('reports cross-entry and resume problems together', () => {
    const { path } = setup((f) => {
      f['stories'][0].id = 'notice-period';
    }, null);
    const r = checkFactBank(path);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.where)).toEqual([
      'stories[0] (id: notice-period)',
      'fields.resume',
    ]);
  });

  it('reports a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fact-bank-'));
    const r = checkFactBank(join(dir, 'nope.yaml'));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ where: 'file', message: 'not found' }]);
  });
});

describe('loadFactBank', () => {
  it('returns the bank for a valid file', () => {
    const { path } = setup();
    expect(loadFactBank(path).fields.fullName).toBe('Sam Example');
  });

  it('throws FactBankError with no file values in the message', () => {
    const { path } = setup((f) => {
      f['fields'].email = 'not-an-email-SECRET';
    });
    try {
      loadFactBank(path);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FactBankError);
      const err = e as FactBankError;
      expect(err.problems.length).toBeGreaterThan(0);
      expect(err.message).toContain('fields.email');
      expect(err.message).not.toContain('SECRET');
    }
  });
});

describe('DEFAULT_FACT_BANK_PATH', () => {
  it('is absolute and sits under the repo root', () => {
    expect(isAbsolute(DEFAULT_FACT_BANK_PATH)).toBe(true);
    expect(
      existsSync(
        join(dirname(dirname(DEFAULT_FACT_BANK_PATH)), 'pnpm-workspace.yaml'),
      ),
    ).toBe(true);
  });
});
