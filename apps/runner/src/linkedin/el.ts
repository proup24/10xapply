/**
 * The parts of a linkedom element the readers use. linkedom types its query
 * results as `any`, so the readers go through this narrow shape instead.
 */
export interface El {
  readonly tagName: string;
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly parentElement: El | null;
  readonly childNodes: ArrayLike<El>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  matches(selector: string): boolean;
  closest(selector: string): El | null;
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown>;
}
/** A document or an element. */
export interface Root {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

export const one = (root: Root, selector: string): El | null =>
  (root.querySelector(selector) as El | null) ?? null;
export const all = (root: Root, selector: string): El[] =>
  Array.from(root.querySelectorAll(selector)) as El[];

/** Whitespace collapsed and trimmed. */
export const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const textOf = (el: El): string => clean(el.textContent ?? '');

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const BLOCKS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'BR',
  'SECTION',
  'ARTICLE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

/**
 * The text under `el`, one line per block element, leaving out every subtree
 * `skip` matches. Empty lines are dropped.
 */
export function blockText(el: El, skip: (e: El) => boolean = () => false) {
  const parts: string[] = [];
  const walk = (node: El) => {
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE || skip(node)) return;
    const block = BLOCKS.has(node.tagName.toUpperCase());
    if (block) parts.push('\n');
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) parts.push('\n');
  };
  for (const child of Array.from(el.childNodes)) walk(child);
  return parts
    .join('')
    .split('\n')
    .map(clean)
    .filter((l) => l !== '')
    .join('\n');
}
