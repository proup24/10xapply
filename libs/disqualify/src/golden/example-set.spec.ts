import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDisqualifyGolden } from './format.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = loadDisqualifyGolden(
  join(here, '..', '..', 'golden', 'example.yaml'),
);
const group = (g: string) => golden.cases.filter((c) => c.group === g);

describe('golden/example.yaml', () => {
  it('uses the example rules', () => {
    expect(golden.rules.authorizedCountries).toEqual(['MA']);
  });

  it.each([
    ['authorization', 10],
    ['sponsorship', 8],
    ['job-page', 8],
    ['near-miss', 8],
    ['location', 3],
    ['language', 3],
  ])('has at least the minimum %s cases', (g, min) => {
    expect(group(g).length).toBeGreaterThanOrEqual(min);
  });

  it('expects pass for every near-miss, location and language case', () => {
    for (const g of ['near-miss', 'location', 'language'])
      for (const c of group(g)) expect(c.expect.verdict, c.id).toBe('pass');
  });

  it('expects no rule claims for location and language cases', () => {
    for (const g of ['location', 'language'])
      for (const c of group(g)) expect(c.expect.claims, c.id).toEqual([]);
  });

  it('includes the Morocco near-miss', () => {
    const c = group('near-miss').find((x) =>
      x.questions?.some((q) => q.label.includes('Morocco')),
    );
    expect(c?.expect.claims).toEqual([
      { kind: 'asks-authorization', countries: ['MA'] },
    ]);
  });

  it('expects disqualified for every authorization and sponsorship case', () => {
    for (const g of ['authorization', 'sponsorship'])
      for (const c of group(g))
        expect(c.expect.verdict, c.id).toBe('disqualified');
  });
});
