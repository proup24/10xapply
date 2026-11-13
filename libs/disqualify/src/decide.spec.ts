import { describe, expect, it } from 'vitest';
import { decide } from './decide.js';
import type { Claim, ClaimKind } from './types.js';

const rules = { authorizedCountries: ['MA'] };
const c = (kind: ClaimKind, countries: string[], quote = kind): Claim => ({
  kind,
  countries,
  countryFrom: 'text',
  quote,
  placeQuote: null,
  source:
    kind === 'asks-authorization' || kind === 'asks-sponsorship'
      ? 's1-q1'
      : 'job-page',
  detail: null,
});
const offer = (countries: string[]) => c('offers-sponsorship', countries);
const disq = (claims: Claim[], offers: Claim[] = []) =>
  decide(claims, rules, offers);

describe('decide', () => {
  it('requires-authorization outside the rules disqualifies', () => {
    const k = c('requires-authorization', ['US']);
    expect(disq([k])).toEqual({ kind: 'disqualified', reasons: [k] });
  });
  it('requires-authorization inside the rules passes', () => {
    expect(disq([c('requires-authorization', ['MA'])])).toEqual({
      kind: 'pass',
    });
  });
  it('requires-authorization is exempt by an offer for the country', () => {
    expect(
      disq([c('requires-authorization', ['US'])], [offer(['US'])]),
    ).toEqual({ kind: 'pass' });
  });
  it('requires-authorization is exempt by an offer with no countries', () => {
    expect(disq([c('requires-authorization', ['US'])], [offer([])])).toEqual({
      kind: 'pass',
    });
  });
  it('an offer for another country does not exempt', () => {
    expect(
      disq([c('requires-authorization', ['US'])], [offer(['CA'])]).kind,
    ).toBe('disqualified');
  });
  it('no-sponsorship is never exempted', () => {
    const k = c('no-sponsorship', ['US']);
    expect(disq([k], [offer(['US'])])).toEqual({
      kind: 'disqualified',
      reasons: [k],
    });
    expect(disq([k], [offer([])]).kind).toBe('disqualified');
  });
  it('no-sponsorship in the rules passes', () => {
    expect(disq([c('no-sponsorship', ['MA'])])).toEqual({ kind: 'pass' });
  });
  it('asks-authorization outside the rules disqualifies', () => {
    expect(disq([c('asks-authorization', ['GB'])]).kind).toBe('disqualified');
  });
  it('asks-sponsorship is exempt by an EU offer', () => {
    expect(disq([c('asks-sponsorship', ['DE'])], [offer(['EU'])])).toEqual({
      kind: 'pass',
    });
  });
  it('any-of: an offer for one country exempts [US, CA]', () => {
    expect(
      disq([c('requires-authorization', ['US', 'CA'])], [offer(['CA'])]),
    ).toEqual({ kind: 'pass' });
  });
  it('any-of: one country in the rules passes [US, MA]', () => {
    expect(disq([c('requires-authorization', ['US', 'MA'])])).toEqual({
      kind: 'pass',
    });
  });
  it('a region the rules are not in disqualifies', () => {
    expect(disq([c('requires-authorization', ['EU'])]).kind).toBe(
      'disqualified',
    );
  });
  it('unclear (no countries) passes', () => {
    expect(disq([c('requires-authorization', [])])).toEqual({ kind: 'pass' });
    expect(disq([c('no-sponsorship', [])])).toEqual({ kind: 'pass' });
  });
  it('location and language claims alone pass', () => {
    expect(
      disq([c('location-requirement', ['US']), c('language-requirement', [])]),
    ).toEqual({ kind: 'pass' });
  });
  it('ignores offers-sponsorship in the claims argument', () => {
    expect(disq([offer(['US'])])).toEqual({ kind: 'pass' });
  });
  it('keeps every disqualifying claim in order', () => {
    const a = c('requires-authorization', ['US']);
    const b = c('asks-sponsorship', ['GB']);
    const log = c('location-requirement', ['US']);
    expect(disq([a, log, b])).toEqual({
      kind: 'disqualified',
      reasons: [a, b],
    });
  });
});
