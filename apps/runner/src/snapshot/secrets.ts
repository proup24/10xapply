const WORD = /[\p{L}\p{N}]/u;
const PHONE_LIKE = /^[\d\s().+-]+$/;
// Whitespace inside a name may appear as a line break, a non-breaking space
// or a separator in a slug or email-like form.
const NAME_GAP = '[\\s _.-]*';
const DIGIT_GAP = '[\\s().+-]*';
/** A phone number with its country code set apart: "+44 7700 900123". */
const INTERNATIONAL = /^\s*\+\d{1,4}[\s().-]+(\d[\d\s().-]*)$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// A name matches inside words (SamExampleCV, Sam_Example_Resume) with any
// separator between its parts, and with no word boundary.
function namePattern(secret: string): string {
  return secret
    .split(/[\s_.-]+/)
    .filter((part) => part.length > 0)
    .map((part) => [...part].map(escapeRegex).join(''))
    .join(NAME_GAP);
}

function patternFor(secret: string, names: Set<string>): string {
  if (names.has(secret)) return namePattern(secret);
  if (PHONE_LIKE.test(secret) && /\d/.test(secret)) {
    const forms = [secret.replace(/\D/g, '')];
    // "+44 7700 900123" is also written "07700 900123" at home.
    const national = INTERNATIONAL.exec(secret)?.[1];
    if (national) forms.push(`0${national.replace(/\D/g, '')}`);
    const any = forms.map((d) => d.split('').join(DIGIT_GAP)).join('|');
    return `(?<!\\d)(?:${any})(?!\\d)`;
  }
  const body = secret
    .split(/\s+/)
    .map((part) => [...part].map(escapeRegex).join(''))
    .join(NAME_GAP);
  const first = [...secret][0] ?? '';
  const last = [...secret].at(-1) ?? '';
  const before = WORD.test(first) ? '(?<![\\p{L}\\p{N}])' : '';
  const after = WORD.test(last) ? '(?![\\p{L}\\p{N}])' : '';
  return `${before}${body}${after}`;
}

/**
 * One case-insensitive pattern for all secrets, longest first. A secret that
 * starts or ends with a word character matches only on word boundaries, spaces
 * inside it match any run of whitespace and separators, and a phone number
 * matches its digits in any layout (one written with its country code also
 * in its national form, a 0 in place of the code). Secrets listed in
 * nameSecrets match inside words, with no boundary.
 */
export function secretPattern(
  secrets: string[],
  nameSecrets: string[] = [],
): RegExp | undefined {
  const names = new Set(nameSecrets.map((s) => s.trim()));
  const usable = [
    ...new Set(secrets.map((s) => s.trim()).filter((s) => s.length > 0)),
  ].sort((a, b) => b.length - a.length);
  if (usable.length === 0) return undefined;
  return new RegExp(usable.map((s) => patternFor(s, names)).join('|'), 'giu');
}
