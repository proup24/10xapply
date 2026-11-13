import { describe, expect, it } from 'vitest';
import {
  ISO_CODES,
  REGIONS,
  expandCountries,
  isCountryToken,
} from './countries.js';

describe('ISO_CODES', () => {
  it('holds the 249 assigned alpha-2 codes', () => {
    expect(ISO_CODES.size).toBe(249);
    expect(ISO_CODES.has('UK')).toBe(false);
    expect(ISO_CODES.has('XX')).toBe(false);
    expect(ISO_CODES.has('MA')).toBe(true);
  });
  it('contains every region member', () => {
    for (const members of Object.values(REGIONS))
      for (const m of members) expect(ISO_CODES.has(m)).toBe(true);
  });
});

describe('expandCountries', () => {
  it('keeps codes and upper-cases them', () => {
    expect(expandCountries(['US'])).toEqual(new Set(['US']));
    expect(expandCountries(['us', 'Ca'])).toEqual(new Set(['US', 'CA']));
  });
  it('aliases and case', () => {
    expect(expandCountries(['UK'])).toEqual(new Set(['GB']));
    expect(expandCountries(['uk'])).toEqual(new Set(['GB']));
    const eu = expandCountries(['Eu']);
    expect(eu.size).toBe(27);
    expect(eu.has('DE')).toBe(true);
    expect(eu.has('GB')).toBe(false);
  });
  it('expands EEA and SCHENGEN', () => {
    const eea = expandCountries(['EEA']);
    expect(eea.size).toBe(30);
    expect(eea.has('NO')).toBe(true);
    const sch = expandCountries(['SCHENGEN']);
    expect(sch.has('CH')).toBe(true);
    expect(sch.has('IE')).toBe(false);
    expect(sch.has('CY')).toBe(false);
  });
  it('throws on an invalid token without echoing it', () => {
    expect(() => expandCountries(['Narnia'])).toThrow('invalid country token');
    expect(() => expandCountries(['Narnia'])).not.toThrow(/Narnia/);
  });
});

describe('isCountryToken', () => {
  it('accepts codes and regions, rejects names', () => {
    expect(isCountryToken('United States')).toBe(false);
    expect(isCountryToken('MA')).toBe(true);
    expect(isCountryToken('ma')).toBe(true);
    expect(isCountryToken('XX')).toBe(false);
    expect(isCountryToken('uk')).toBe(true);
    expect(isCountryToken('Schengen')).toBe(true);
  });
});
