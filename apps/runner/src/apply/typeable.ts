/** Typographic characters and the ASCII typed in their place. */
const MAP: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '″': '"',
  '–': '-',
  '—': '-',
  '‒': '-',
  '−': '-',
  '…': '...',
  ' ': ' ',
};

const MAPPED = new RegExp(`[${Object.keys(MAP).join('')}]`, 'gu');
const TYPEABLE = /^[\x20-\x7e\n]*$/;

/**
 * The text pace will type: typographic quotes, dashes, ellipses and the
 * no-break space turned into ASCII. Null when anything else outside
 * printable ASCII and `\n` is left, so no changed letter is ever typed.
 */
export function toTypeable(text: string): string | null {
  const mapped = text.replace(MAPPED, (ch) => MAP[ch] ?? ch);
  return TYPEABLE.test(mapped) ? mapped : null;
}
