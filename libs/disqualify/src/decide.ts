import { expandCountries } from './countries.js';
import type { Rules } from './rules.js';
import type { Claim } from './types.js';

export type Verdict =
  { kind: 'pass' } | { kind: 'disqualified'; reasons: Claim[] };

const DECIDING = new Set([
  'requires-authorization',
  'no-sponsorship',
  'asks-authorization',
  'asks-sponsorship',
]);

/**
 * Decides from validated claims and the rules alone. `offers` are the job
 * page's offers-sponsorship claims; any in `claims` are ignored. Reasons keep
 * the claims' order.
 */
export function decide(
  claims: Claim[],
  rules: Rules,
  offers: Claim[],
): Verdict {
  const authorized = new Set(
    rules.authorizedCountries.map((c) => c.toUpperCase()),
  );
  const offerSets = offers.map((o) => ({
    all: o.countries.length === 0,
    codes:
      o.countries.length === 0
        ? new Set<string>()
        : expandCountries(o.countries),
  }));
  const reasons: Claim[] = [];
  for (const claim of claims) {
    if (!DECIDING.has(claim.kind) || claim.countries.length === 0) continue;
    const codes = expandCountries(claim.countries);
    if ([...codes].some((c) => authorized.has(c))) continue;
    if (claim.kind === 'no-sponsorship') {
      reasons.push(claim);
      continue;
    }
    const exempt = offerSets.some(
      (o) => o.all || [...codes].some((c) => o.codes.has(c)),
    );
    if (!exempt) reasons.push(claim);
  }
  return reasons.length > 0
    ? { kind: 'disqualified', reasons }
    : { kind: 'pass' };
}
