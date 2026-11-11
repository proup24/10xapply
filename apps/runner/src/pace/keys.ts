/**
 * US keyboard layout facts the pace module needs: which characters take
 * Shift, and the physical key (its unshifted character) behind each one.
 */

/** Shifted symbol → the unshifted character on the same key. */
const UNSHIFTED: Record<string, string> = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
};

/** True for characters a US keyboard types with Shift held. */
export function needsShift(ch: string): boolean {
  return /^[A-Z]$/.test(ch) || ch in UNSHIFTED;
}

/**
 * The character of the physical key that types `ch`, unshifted: `A` → `a`,
 * `!` → `1`; anything else is returned as is. Two characters are the same
 * key when their physical keys are equal.
 */
export function physicalKey(ch: string): string {
  if (/^[A-Z]$/.test(ch)) return ch.toLowerCase();
  return UNSHIFTED[ch] ?? ch;
}
