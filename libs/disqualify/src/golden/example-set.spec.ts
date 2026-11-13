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
    ['job-page', 10],
    ['near-miss', 8],
    ['location', 30],
    ['language', 3],
  ])('has at least the minimum %s cases', (g, min) => {
    expect(group(g).length).toBeGreaterThanOrEqual(min);
  });

  it('expects pass for every near-miss and language case', () => {
    for (const g of ['near-miss', 'language'])
      for (const c of group(g)) expect(c.expect.verdict, c.id).toBe('pass');
  });

  it('expects no rule claims for language cases', () => {
    for (const c of group('language'))
      expect(c.expect.claims, c.id).toEqual([]);
  });

  it('location: a pass lists no claim, a skip lists only the deciding one', () => {
    for (const c of group('location'))
      expect(c.expect.claims, c.id).toHaveLength(
        c.expect.verdict === 'pass' ? 0 : 1,
      );
  });

  it("flips 05b's location cases to skips", () => {
    const of = (id: string) => golden.cases.find((c) => c.id === id)?.expect;
    expect(of('loc-based-in-berlin')).toEqual({
      verdict: 'disqualified',
      claims: [{ kind: 'requires-location', countries: ['DE'] }],
    });
    expect(of('loc-hybrid-paris')).toEqual({
      verdict: 'disqualified',
      claims: [{ kind: 'requires-location', countries: ['FR'] }],
    });
    expect(of('loc-onsite-question')).toEqual({
      verdict: 'disqualified',
      claims: [{ kind: 'asks-location', countries: ['IE'] }],
    });
  });

  it('accepts either kind for "US-based candidates only"', () => {
    const c = golden.cases.find((x) => x.id === 'loc-jp-us-based-only');
    expect(c?.expect.claims).toEqual([
      {
        kind: ['requires-location', 'requires-authorization'],
        countries: ['US'],
      },
    ]);
  });

  it('includes the Morocco near-miss', () => {
    const c = group('near-miss').find((x) =>
      x.questions?.some((q) => q.label.includes('Morocco')),
    );
    expect(c?.expect.claims).toEqual([
      { kind: 'asks-authorization', countries: ['MA'] },
    ]);
  });

  it('guards against a false "they sponsor"', () => {
    for (const id of [
      'jp-relocation-only-and-form-asks',
      'jp-sponsors-germany-and-us-question',
    ])
      expect(golden.cases.find((c) => c.id === id)?.expect.verdict, id).toBe(
        'disqualified',
      );
  });

  it('expects disqualified for every authorization and sponsorship case', () => {
    for (const g of ['authorization', 'sponsorship'])
      for (const c of group(g))
        expect(c.expect.verdict, c.id).toBe('disqualified');
  });
});
