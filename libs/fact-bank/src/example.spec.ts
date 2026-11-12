import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFactBank } from './bank.js';

const examplePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fact-bank.example.yaml',
);

describe('fact-bank.example.yaml', () => {
  const result = checkFactBank(examplePath);

  it('passes the check with no warnings', () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('shows every kind of entry', () => {
    expect(result.counts.facts).toBeGreaterThan(0);
    expect(result.counts.answers).toBeGreaterThan(0);
    expect(result.counts.stories).toBe(2);
    const bank = result.bank;
    expect(bank).toBeDefined();
    expect(bank?.answers.some((a) => a.variants !== undefined)).toBe(true);
    expect(bank?.answers.some((a) => a.answer?.includes('{source}'))).toBe(
      true,
    );
    expect(
      bank?.facts.some((f) => f.tags.length > 0 && f.confirmed !== undefined),
    ).toBe(true);
  });
});
