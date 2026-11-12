import { describe, expect, it } from 'vitest';
import {
  countryAndCodeOption,
  FIELD_PATTERNS,
  fieldValue,
  mapField,
  normalizeLabel,
} from './fields.js';
import { bank } from './testing/bank.js';
import type { FormQuestion } from './types.js';

const q = (over: Partial<FormQuestion> = {}): FormQuestion => ({
  id: 'q1',
  label: 'A question',
  type: 'text',
  required: true,
  ...over,
});

describe('normalizeLabel', () => {
  it('lowercases and drops markers and punctuation', () => {
    expect(normalizeLabel('First name*')).toBe('first name');
    expect(normalizeLabel('  Mobile   phone number (optional) ')).toBe(
      'mobile phone number',
    );
    expect(normalizeLabel('Email (required):')).toBe('email');
  });
  it('collapses only an exactly doubled label', () => {
    expect(normalizeLabel('First name First name')).toBe('first name');
    expect(normalizeLabel('name name name')).toBe('name name name');
    expect(normalizeLabel('city city')).toBe('city');
  });
});

describe('FIELD_PATTERNS', () => {
  it('holds only normalized whole labels', () => {
    for (const patterns of Object.values(FIELD_PATTERNS)) {
      for (const p of patterns) expect(normalizeLabel(p)).toBe(p);
    }
  });
});

describe('fieldValue', () => {
  it('reads the bank', () => {
    expect(fieldValue('firstName', bank)).toBe('Sam');
    expect(fieldValue('phone', bank)).toBe(bank.fields.phone.full);
    expect(fieldValue('website', bank)).toBeUndefined();
  });
});

describe('mapField', () => {
  it('fills a text field', () => {
    expect(
      mapField(q({ label: 'First name*', type: 'text' }), bank),
    ).toMatchObject({ kind: 'filled', key: 'firstName', value: 'Sam' });
  });
  it('collapses a doubled label', () => {
    expect(mapField(q({ label: 'First name First name' }), bank)).toMatchObject(
      { key: 'firstName' },
    );
  });
  it('fills the phone', () => {
    expect(
      mapField(q({ label: 'Mobile phone number (optional)' }), bank),
    ).toMatchObject({ key: 'phone', value: bank.fields.phone.full });
  });
  it('never fills a longer question that merely contains a pattern', () => {
    expect(
      mapField(q({ label: 'Which city would you like to work in?' }), bank),
    ).toEqual({ kind: 'none' });
  });
  it('matches an option that holds the country and the code', () => {
    expect(
      mapField(
        q({
          label: 'Phone country code',
          type: 'select',
          options: ['France (+33)', 'United Kingdom (+44)'],
        }),
        bank,
      ),
    ).toMatchObject({ kind: 'filled', value: 'United Kingdom (+44)' });
  });
  it('gives the code or country name on a text type', () => {
    expect(mapField(q({ label: 'Country code' }), bank)).toMatchObject({
      value: bank.fields.phone.countryCode,
    });
    expect(mapField(q({ label: 'Phone country' }), bank)).toMatchObject({
      value: bank.fields.phone.country,
    });
  });
  it('reports no-option without a value in the detail', () => {
    const r = mapField(
      q({
        label: 'Email address',
        type: 'select',
        options: ['other@example.com'],
      }),
      bank,
    );
    expect(r).toEqual({
      kind: 'no-option',
      detail: 'no option matches field email',
    });
  });
  it('returns no-option for phone on a choice type', () => {
    expect(
      mapField(q({ label: 'Phone', type: 'select', options: ['1'] }), bank),
    ).toMatchObject({ kind: 'no-option' });
  });
  it('blocks when the bank is silent', () => {
    expect(mapField(q({ label: 'Website' }), bank)).toEqual({
      kind: 'blocked',
      reason: 'bank-silent',
      detail: 'bank has no value for field website',
    });
  });
  it('maps the resume only on a file type', () => {
    expect(mapField(q({ label: 'Resume', type: 'file' }), bank)).toMatchObject({
      kind: 'filled',
      key: 'resume',
      value: bank.fields.resume,
    });
    expect(mapField(q({ label: 'Resume', type: 'text' }), bank)).toEqual({
      kind: 'none',
    });
    expect(mapField(q({ label: 'Cover letter', type: 'file' }), bank)).toEqual({
      kind: 'none',
    });
    expect(mapField(q({ label: 'First name', type: 'file' }), bank)).toEqual({
      kind: 'none',
    });
  });

  describe('phone country option matching', () => {
    const us = {
      ...bank,
      fields: {
        ...bank.fields,
        phone: {
          ...bank.fields.phone,
          country: 'United States',
          countryCode: '+1',
        },
      },
    };
    const pick = (options: string[]) =>
      mapField(q({ label: 'Phone country code', type: 'select', options }), us);

    it('does not let +1 match +1242', () => {
      expect(pick(['Bahamas (+1242)', 'United States (+1)'])).toMatchObject({
        kind: 'filled',
        value: 'United States (+1)',
      });
      expect(pick(['Bahamas (+1242)'])).toMatchObject({ kind: 'no-option' });
    });
    it('does not pick a longer country name', () => {
      expect(pick(['United States Minor Outlying Islands (+1)'])).toMatchObject(
        { kind: 'no-option' },
      );
      expect(
        pick([
          'United States Minor Outlying Islands (+1)',
          'United States (+1)',
        ]),
      ).toMatchObject({ value: 'United States (+1)' });
    });
    it('returns no-option when two options match equally', () => {
      expect(pick(['United States (+1)', 'united states +1'])).toEqual({
        kind: 'no-option',
        detail: 'no option matches field phoneCountryCode',
      });
    });
    it('never matches everything on an empty country or code', () => {
      const empty = {
        ...us,
        fields: {
          ...us.fields,
          phone: { ...us.fields.phone, country: '', countryCode: '' },
        },
      };
      expect(
        mapField(
          q({
            label: 'Phone country',
            type: 'select',
            options: ['Anything (+1)'],
          }),
          empty,
        ),
      ).toMatchObject({ kind: 'blocked', reason: 'bank-silent' });
    });

    const withPhone = (country: string, countryCode: string) => ({
      ...us,
      fields: {
        ...us.fields,
        phone: { ...us.fields.phone, country, countryCode },
      },
    });

    it('an empty country never matches, even a bare code option', () => {
      expect(countryAndCodeOption(['+1'], withPhone('', '+1'))).toBeNull();
      expect(
        mapField(
          q({ label: 'Phone country', type: 'select', options: ['+1'] }),
          withPhone('', '+1'),
        ),
      ).toMatchObject({ kind: 'blocked', reason: 'bank-silent' });
    });
    it('an empty code never matches through countryAndCodeOption', () => {
      const b = withPhone('United States', '');
      expect(countryAndCodeOption(['United States'], b)).toBeNull();
      expect(countryAndCodeOption(['United States (+1)'], b)).toBeNull();
      expect(
        mapField(
          q({
            label: 'Phone country',
            type: 'select',
            options: ['United States (+1)'],
          }),
          b,
        ),
      ).toMatchObject({ kind: 'no-option' });
      // The plain exact match still works for the country name.
      expect(
        mapField(
          q({
            label: 'Phone country',
            type: 'select',
            options: ['United States'],
          }),
          b,
        ),
      ).toMatchObject({ kind: 'filled', value: 'United States' });
    });
    it('never fills a choice field from an empty bank value', () => {
      for (const options of [[''], [' '], ['', 'Other']]) {
        expect(
          mapField(
            q({ label: 'Phone country code', type: 'select', options }),
            withPhone('United States', ''),
          ),
        ).toMatchObject({ kind: 'blocked', reason: 'bank-silent' });
      }
    });
  });
});
