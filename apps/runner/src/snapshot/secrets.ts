const WORD = /[\p{L}\p{N}]/u;
const PHONE_LIKE = /^[\d\s().+-]+$/;
// Whitespace inside a name may appear as a line break, a non-breaking space
// or a separator in a slug or email-like form.
const NAME_GAP = '[\\s _.-]*';
const DIGIT_GAP = '[\\s().+-]*';
/** A phone number with its country code set apart: "+44 7700 900123". */
const INTERNATIONAL = /^\s*\+(\d{1,4})[\s().-]+(\d[\d\s().-]*)$/;
// A number may open with "(", "+" or "(+"; the match takes them too, so no
// stray "+" or "(" is left beside the replacement.
const PHONE_OPEN = '\\(?\\+?';

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
    const gaps = (d: string) => d.split('').join(DIGIT_GAP);
    const forms = [`${PHONE_OPEN}${gaps(secret.replace(/\D/g, ''))}`];
    const intl = INTERNATIONAL.exec(secret);
    if (intl?.[1] && intl[2]) {
      const code = gaps(intl[1]);
      const national = gaps(intl[2].replace(/\D/g, ''));
      // "+44 7700 900123" is also written "07700 900123" or "(0)7700 900123"
      // at home, "+44 (0)7700 900123" or "0044 7700 900123" abroad.
      forms.push(`\\(?0${DIGIT_GAP}${national}`);
      forms.push(
        `${PHONE_OPEN}(?:00)?${code}${DIGIT_GAP}(?:0${DIGIT_GAP})?${national}`,
      );
    }
    return `(?<!\\d)(?:${forms.join('|')})(?!\\d)`;
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
 * matches its digits in any layout, with any "(" or "+" in front of it (one
 * written with its country code also in its national form, a 0 or "(0)" in
 * place of the code, as "+44 (0)..." and as "0044 ..."). Secrets listed in
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
