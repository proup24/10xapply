import type { FactBank } from '@xapply/fact-bank';
import { fieldValue as sourceFieldValue, matchOption } from './sources.js';
import { CHOICE_TYPES, type FieldKey, type FormQuestion } from './types.js';

/**
 * Lower case, without `*`, `(optional)`, `(required)` and punctuation, with
 * whitespace collapsed. A label that is exactly the same phrase twice (some
 * forms repeat it for screen readers) becomes one copy.
 */
export function normalizeLabel(label: string): string {
  const words = label
    .toLowerCase()
    .replace(/\((?:optional|required)\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
  const half = words.length / 2;
  if (
    words.length >= 2 &&
    Number.isInteger(half) &&
    words.slice(0, half).join(' ') === words.slice(half).join(' ')
  ) {
    return words.slice(0, half).join(' ');
  }
  return words.join(' ');
}

/** Whole normalized labels. A label must equal one of these, never contain it. */
export const FIELD_PATTERNS: Record<FieldKey, string[]> = {
  firstName: ['first name', 'given name'],
  lastName: ['last name', 'surname', 'family name'],
  fullName: ['name', 'full name'],
  email: ['email', 'email address'],
  phone: [
    'phone',
    'phone number',
    'mobile',
    'mobile phone number',
    'mobile number',
  ],
  phoneCountryCode: ['country code', 'phone country code'],
  phoneCountry: ['phone country'],
  city: ['city'],
  location: ['location', 'location city', 'current location'],
  country: ['country', 'country of residence'],
  linkedin: [
    'linkedin',
    'linkedin profile',
    'linkedin url',
    'linkedin profile url',
  ],
  github: ['github', 'github profile', 'github url'],
  portfolio: ['portfolio', 'portfolio url', 'portfolio website'],
  website: ['website', 'personal website'],
  resume: ['resume', 'cv', 'resume cv', 'upload resume'],
};

/** The bank's value for a field, or undefined when the bank has none. */
export function fieldValue(key: FieldKey, bank: FactBank): string | undefined {
  return sourceFieldValue(key, bank) ?? undefined;
}

export type FieldMapping =
  | { kind: 'none' }
  | { kind: 'filled'; key: FieldKey; value: string }
  | { kind: 'blocked'; reason: 'bank-silent'; detail: string }
  | { kind: 'no-option'; detail: string };

function keyForLabel(label: string): FieldKey | null {
  const wanted = normalizeLabel(label);
  for (const [key, patterns] of Object.entries(FIELD_PATTERNS)) {
    if (patterns.includes(wanted)) return key as FieldKey;
  }
  return null;
}

/**
 * An option such as "United Kingdom (+44)": the code as a whole token (not
 * followed by a digit) and, once the code and its brackets and punctuation are
 * removed, exactly the country name. Null when none or more than one matches.
 */
function countryAndCodeOption(
  options: string[],
  bank: FactBank,
): string | null {
  const country = bank.fields.phone.country.trim().toLowerCase();
  const code = bank.fields.phone.countryCode.trim();
  if (country === '' || code === '') return null;
  const codeToken = new RegExp(
    `(?<![\\d+])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`,
  );
  const matches = options.filter((o) => {
    if (!codeToken.test(o)) return false;
    const rest = o
      .replace(codeToken, ' ')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    return rest === country.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  });
  return matches.length === 1 ? (matches[0] as string) : null;
}

/**
 * Fills a simple field straight from the bank, without a model. Returns
 * `none` when the label is not a whole known field label. `detail` strings
 * name the field key only, never a value.
 */
export function mapField(q: FormQuestion, bank: FactBank): FieldMapping {
  const key = keyForLabel(q.label);
  if (key === null) return { kind: 'none' };

  if (q.type === 'file') {
    if (key !== 'resume') return { kind: 'none' };
  } else if (key === 'resume') {
    return { kind: 'none' };
  }

  const value = fieldValue(key, bank);
  if (value === undefined) {
    return {
      kind: 'blocked',
      reason: 'bank-silent',
      detail: `bank has no value for field ${key}`,
    };
  }

  if (!CHOICE_TYPES.includes(q.type as never)) {
    return { kind: 'filled', key, value };
  }

  const options = q.options ?? [];
  const matched =
    key === 'phone'
      ? null
      : (matchOption(value, options) ??
        (key === 'phoneCountryCode' || key === 'phoneCountry'
          ? countryAndCodeOption(options, bank)
          : null));
  if (matched === null) {
    return { kind: 'no-option', detail: `no option matches field ${key}` };
  }
  return { kind: 'filled', key, value: matched };
}
