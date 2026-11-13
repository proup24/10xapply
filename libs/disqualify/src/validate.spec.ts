import { describe, expect, it } from 'vitest';
import type { Claim } from './types.js';
import { normalizeText, validateClaims } from './validate.js';

const PAGE = 'We can’t\nsponsor visas. Based in Austin, Texas.';
const ctx = () => ({
  sources: new Map<string, string>([
    ['job-page', PAGE],
    ['s1-q1', 'Are you legally authorized to work in the UK?\nYes\nNo'],
  ]),
  place: 'Senior Engineer. Based in Austin, Texas.',
});
const claim = (over: Partial<Claim> = {}): Claim => ({
  kind: 'no-sponsorship',
  countries: ['US'],
  countryFrom: 'text',
  quote: "we can't sponsor visas",
  placeQuote: null,
  source: 'job-page',
  detail: null,
  ...over,
});

describe('normalizeText', () => {
  it('lower-cases, maps typography and collapses whitespace', () => {
    expect(normalizeText('  We CAN’T \n “go” – now − ok ′ ″ ‘x’ — y ')).toBe(
      "we can't \"go\" - now - ok ' \" 'x' - y",
    );
  });
  it('treats a no-break space (U+00A0) as a space', () => {
    expect(normalizeText('a\u00a0b')).toBe('a b');
    expect(normalizeText('work\u00a0in the\u00a0US')).toBe('work in the us');
  });
});

describe('validateClaims', () => {
  it('accepts a valid claim', () => {
    expect(validateClaims([claim()], ctx())).toEqual([]);
  });
  it('quote matches across typography and line breaks', () => {
    expect(
      validateClaims([claim({ quote: "we can't sponsor visas" })], ctx()),
    ).toEqual([]);
  });
  it('flags a quote not in its source without echoing it', () => {
    const q = 'zebra crossing secret';
    const p = validateClaims([claim({ quote: q })], ctx());
    expect(p).toEqual(['claim 0: quote not found in its source']);
    expect(p.join()).not.toContain(q);
  });
  it('flags an empty quote', () => {
    expect(validateClaims([claim({ quote: '  ' })], ctx())).toEqual([
      'claim 0: quote is empty',
    ]);
  });
  it('flags an unknown source', () => {
    expect(validateClaims([claim({ source: 's9-q9' })], ctx())).toEqual([
      'claim 0: source is not in this check',
    ]);
  });
  it('country names are invalid', () => {
    const p = validateClaims([claim({ countries: ['United States'] })], ctx());
    expect(p).toEqual(['claim 0: countries holds an invalid country token']);
    expect(p.join()).not.toContain('United States');
  });
  it('accepts regions and the UK alias', () => {
    expect(validateClaims([claim({ countries: ['eu', 'UK'] })], ctx())).toEqual(
      [],
    );
  });
  it('job-description needs a placeQuote that is found in the place', () => {
    const c = (placeQuote: string | null) =>
      claim({ countryFrom: 'job-description', placeQuote });
    expect(validateClaims([c(null)], ctx())).toEqual([
      'claim 0: placeQuote is missing',
    ]);
    expect(validateClaims([c('  ')], ctx())).toEqual([
      'claim 0: placeQuote is missing',
    ]);
    const p = validateClaims([c('Based in Paris')], ctx());
    expect(p).toEqual([
      'claim 0: placeQuote not found in the job title or description',
    ]);
    expect(p.join()).not.toContain('Paris');
    expect(validateClaims([c('based in  austin,\ntexas')], ctx())).toEqual([]);
  });
  it('an offer must come from the job page', () => {
    const p = validateClaims(
      [
        claim({
          kind: 'offers-sponsorship',
          source: 's1-q1',
          quote: 'authorized to work in the uk',
        }),
      ],
      ctx(),
    );
    expect(p).toEqual([
      'claim 0: offers-sponsorship must come from the job page',
    ]);
  });
  it('asks-* must come from a question', () => {
    expect(
      validateClaims([claim({ kind: 'asks-sponsorship' })], ctx()),
    ).toEqual(['claim 0: asks-sponsorship must come from a form question']);
    expect(
      validateClaims([claim({ kind: 'asks-authorization' })], ctx()),
    ).toEqual(['claim 0: asks-authorization must come from a form question']);
    expect(
      validateClaims(
        [
          claim({
            kind: 'asks-authorization',
            source: 's1-q1',
            quote: 'authorized to work in the UK',
            countries: ['GB'],
          }),
        ],
        ctx(),
      ),
    ).toEqual([]);
  });
  it('a language claim needs a detail', () => {
    const lang = (detail: string | null) =>
      claim({ kind: 'language-requirement', countries: [], detail });
    expect(validateClaims([lang(null)], ctx())).toEqual([
      'claim 0: detail is missing',
    ]);
    expect(validateClaims([lang(' ')], ctx())).toEqual([
      'claim 0: detail is missing',
    ]);
    expect(validateClaims([lang('German')], ctx())).toEqual([]);
  });
  it('offers-relocation must come from the job page', () => {
    expect(
      validateClaims(
        [
          claim({
            kind: 'offers-relocation',
            source: 's1-q1',
            quote: 'authorized to work in the uk',
          }),
        ],
        ctx(),
      ),
    ).toEqual(['claim 0: offers-relocation must come from the job page']);
  });
  it('asks-location must come from a form question', () => {
    expect(
      validateClaims(
        [claim({ kind: 'asks-location', detail: 'Texas' })],
        ctx(),
      ),
    ).toEqual(['claim 0: asks-location must come from a form question']);
  });
  it('location kinds need a detail', () => {
    for (const kind of [
      'requires-location',
      'asks-location',
      'location-preference',
    ] as const) {
      const p = validateClaims(
        [
          claim({
            kind,
            source: kind === 'asks-location' ? 's1-q1' : 'job-page',
            quote:
              kind === 'asks-location'
                ? 'authorized to work in the uk'
                : 'based in austin',
            detail: null,
          }),
        ],
        ctx(),
      );
      expect(p, kind).toEqual(['claim 0: detail is missing']);
    }
    expect(
      validateClaims(
        [
          claim({
            kind: 'offers-relocation',
            quote: 'based in austin',
            detail: null,
          }),
        ],
        ctx(),
      ),
    ).toEqual([]);
  });
  it('a closed-list question quotes its label', () => {
    const label = 'Which country are you based in?';
    const c = {
      sources: new Map([['s1-q1', `${label}\nGermany\nAustria\nSwitzerland`]]),
      place: '',
    };
    expect(
      validateClaims(
        [
          claim({
            kind: 'asks-location',
            countries: ['DE', 'AT', 'CH'],
            quote: label,
            source: 's1-q1',
            detail: 'Germany, Austria, Switzerland',
          }),
        ],
        c,
      ),
    ).toEqual([]);
  });
  it('names the claim index', () => {
    const p = validateClaims([claim(), claim({ source: 'nope' })], ctx());
    expect(p).toEqual(['claim 1: source is not in this check']);
  });
});
