import { isCountryToken } from './countries.js';
import type { Claim, ClaimSource } from './types.js';

/** Lower-cases, maps typographic quotes and dashes, and collapses whitespace. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ValidateContext {
  /** Each source's text: the job page's title and description, or a question's label, help and options. */
  sources: Map<ClaimSource, string>;
  /** The job's title and description. */
  place: string;
}

const ASKS = new Set(['asks-authorization', 'asks-sponsorship']);

/**
 * Checks claims against the text they came from. Problems are in our own words
 * and never repeat a quote, detail or country token: all of it is model output
 * or page text.
 */
export function validateClaims(
  claims: Claim[],
  ctx: ValidateContext,
): string[] {
  const problems: string[] = [];
  claims.forEach((claim, i) => {
    const bad = (what: string) => problems.push(`claim ${i}: ${what}`);
    const quote = normalizeText(claim.quote);
    const sourceText = ctx.sources.get(claim.source);
    if (sourceText === undefined) bad('source is not in this check');
    if (quote === '') bad('quote is empty');
    else if (
      sourceText !== undefined &&
      !normalizeText(sourceText).includes(quote)
    )
      bad('quote not found in its source');
    if (!claim.countries.every(isCountryToken))
      bad('countries holds an invalid country token');
    if (claim.countryFrom === 'job-description') {
      const pq = normalizeText(claim.placeQuote ?? '');
      if (pq === '') bad('placeQuote is missing');
      else if (!normalizeText(ctx.place).includes(pq))
        bad('placeQuote not found in the job title or description');
    }
    if (claim.kind === 'offers-sponsorship' && claim.source !== 'job-page')
      bad('offers-sponsorship must come from the job page');
    if (ASKS.has(claim.kind) && claim.source === 'job-page')
      bad(`${claim.kind} must come from a form question`);
    if (
      (claim.kind === 'location-requirement' ||
        claim.kind === 'language-requirement') &&
      (claim.detail ?? '').trim() === ''
    )
      bad('detail is missing');
  });
  return problems;
}
