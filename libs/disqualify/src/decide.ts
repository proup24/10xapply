import { expandCountries } from './countries.js';
import type { Rules } from './rules.js';
import type { Claim, RuleKind } from './types.js';

export type Verdict =
  { kind: 'pass' } | { kind: 'disqualified'; reasons: Claim[] };

interface Family {
  deciding: readonly RuleKind[];
  neverExempt: readonly RuleKind[];
  offer: RuleKind;
  allowed: (r: Rules) => string[];
}

const FAMILIES: readonly Family[] = [
  {
    deciding: [
      'requires-authorization',
      'no-sponsorship',
      'asks-authorization',
      'asks-sponsorship',
    ],
    neverExempt: ['no-sponsorship'],
    offer: 'offers-sponsorship',
    allowed: (r) => r.authorizedCountries,
  },
  {
    deciding: ['requires-location', 'asks-location'],
    neverExempt: [],
    offer: 'offers-relocation',
    allowed: (r) => r.locatedIn,
  },
];

/**
 * Decides from validated claims and the rules alone. Two families: authorization
 * (judged against `authorizedCountries`, exempted by offers-sponsorship) and
 * location (judged against `locatedIn`, exempted by offers-relocation). `offers`
 * are the job page's offer claims, sorted by kind; an offer only exempts its own
 * family, and one with no countries exempts every country in it. Offer claims in
 * `claims` are ignored. Reasons keep the claims' order.
 */
export function decide(
  claims: Claim[],
  rules: Rules,
  offers: Claim[],
): Verdict {
  const reasons: Claim[] = [];
  for (const claim of claims) {
    const family = FAMILIES.find((f) =>
      f.deciding.some((k) => k === claim.kind),
    );
    if (!family || claim.countries.length === 0) continue;
    const allowed = new Set(family.allowed(rules).map((c) => c.toUpperCase()));
    const codes = expandCountries(claim.countries);
    if ([...codes].some((c) => allowed.has(c))) continue;
    if (family.neverExempt.some((k) => k === claim.kind)) {
      reasons.push(claim);
      continue;
    }
    const exempt = offers
      .filter((o) => o.kind === family.offer)
      .some(
        (o) =>
          o.countries.length === 0 ||
          [...expandCountries(o.countries)].some((c) => codes.has(c)),
      );
    if (!exempt) reasons.push(claim);
  }
  return reasons.length > 0
    ? { kind: 'disqualified', reasons }
    : { kind: 'pass' };
}
