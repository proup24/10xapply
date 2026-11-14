import { basename } from 'node:path';
import type { FactBank } from '@xapply/fact-bank';
import { parsePage } from '../linkedin/dom.js';
import { secretPattern } from './secrets.js';

export interface ScrubCounts {
  removedElements: number;
  blankedTexts: number;
  secretsReplaced: number;
  droppedAttributes: number;
}

const REMOVE_TAGS = new Set([
  'script',
  'style',
  'link',
  'meta',
  'noscript',
  'iframe',
  'svg',
  'img',
]);
// Attributes that carry a URL or markup are always dropped. formaction,
// poster and srcdoc go beyond the spec's list; they are URLs or markup too.
const DROP_ATTRIBUTES = new Set([
  'href',
  'xlink:href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'srcdoc',
  'style',
]);
const KEEP_TEXT_TAGS = new Set([
  'label',
  'legend',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'button',
  'option',
  'fieldset',
]);
const DROP_STATE_ATTRIBUTES = new Set([
  'selected',
  'checked',
  'aria-checked',
  'aria-selected',
  'aria-pressed',
]);
// Free text in attributes: kept as x's of the same length.
const BLANK_ATTRIBUTES = new Set([
  'title',
  'placeholder',
  'alt',
  'aria-valuetext',
  'aria-description',
]);
const BLANK_VALUE_TAGS = new Set(['option', 'button', 'select', 'li', 'data']);
/** Any email address, in the bank or not. */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const URL_VALUE = /^\s*(https?:|\/\/|data:|javascript:)/i;
const KEEP_TEXT_ROLES = new Set(['option', 'radio', 'checkbox']);
const KEEP_ARIA_LABEL_TAGS = new Set(['input', 'select', 'textarea', 'button']);
const KEEP_ARIA_LABEL_ROLES = new Set([
  'radio',
  'checkbox',
  'option',
  'combobox',
]);

// linkedom's node types, kept loose: the runner has no DOM lib.
interface Attr {
  name: string;
  value: string;
}
interface DomNode {
  removeChild(child: DomNode): unknown;
  nodeType: number;
  nodeValue: string | null;
  childNodes: ArrayLike<DomNode>;
  parentNode: DomNode | null;
}
interface DomElement extends DomNode {
  tagName: string;
  attributes: ArrayLike<Attr>;
  textContent: string | null;
  content?: DomNode;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
const CDATA = 4;

const attr = (el: DomElement, name: string) =>
  (el.getAttribute(name) ?? '').trim().toLowerCase();

const blank = (text: string) => text.replace(/\S/g, 'x');

/** Text typed by a person: blank it whatever its ancestors keep. */
function isFreeText(el: DomElement, tag: string): boolean {
  if (tag === 'textarea' || attr(el, 'role') === 'textbox') return true;
  const editable = el.getAttribute('contenteditable');
  return editable !== null && editable.trim().toLowerCase() !== 'false';
}

function isEmbeddedJson(el: DomElement, tag: string): boolean {
  if (attr(el, 'type') === 'application/ld+json') return true;
  if (tag !== 'code') return false;
  const text = (el.textContent ?? '').trim();
  return text.startsWith('{') || text.startsWith('[');
}

function shouldRemove(el: DomElement, tag: string): boolean {
  if (REMOVE_TAGS.has(tag)) return true;
  if (tag === 'input' && attr(el, 'type') === 'hidden') return true;
  return isEmbeddedJson(el, tag);
}

function keepsText(el: DomElement, tag: string, described: Set<string>) {
  if (KEEP_TEXT_TAGS.has(tag)) return true;
  if (KEEP_TEXT_ROLES.has(attr(el, 'role'))) return true;
  const id = el.getAttribute('id');
  return id !== null && described.has(id);
}

function keepsAriaLabel(el: DomElement, tag: string): boolean {
  return (
    KEEP_ARIA_LABEL_TAGS.has(tag) || KEEP_ARIA_LABEL_ROLES.has(attr(el, 'role'))
  );
}

/**
 * Scrubs a raw snapshot so Claude may read it and it may be committed as a
 * fixture. See the spec's "Snapshots and locators". Structure decides what
 * survives: form wording is kept, every other text becomes `x`s, and any
 * remaining text or attribute value that holds a secret, or any email
 * address, has it replaced.
 */
export function scrubSnapshot(
  html: string,
  secrets: string[],
  nameSecrets: string[],
): { html: string; counts: ScrubCounts } {
  const document = parsePage(html);
  const counts: ScrubCounts = {
    removedElements: 0,
    blankedTexts: 0,
    secretsReplaced: 0,
    droppedAttributes: 0,
  };

  const pattern = secretPattern(secrets, nameSecrets);
  const replaceSecrets = (value: string): string => {
    const hit = () => {
      counts.secretsReplaced++;
      return '[secret]';
    };
    // Emails first, so a name inside one can't leave the rest behind.
    const emails = value.replace(EMAIL, hit);
    return pattern ? emails.replace(pattern, hit) : emails;
  };

  const root = document as unknown as DomNode & {
    querySelectorAll(s: string): ArrayLike<DomElement>;
  };
  const described = new Set<string>();
  for (const el of Array.from(root.querySelectorAll('[aria-describedby]'))) {
    for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/)) {
      if (id) described.add(id);
    }
  }

  const visit = (node: DomNode, keep: boolean): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === COMMENT || child.nodeType === CDATA) {
        child.parentNode?.removeChild(child);
        counts.removedElements++;
        continue;
      }
      if (child.nodeType === TEXT) {
        const text = child.nodeValue ?? '';
        let next = text;
        if (!keep) {
          next = blank(text);
          if (next !== text) counts.blankedTexts++;
        }
        next = replaceSecrets(next);
        if (next !== text) child.nodeValue = next;
        continue;
      }
      if (child.nodeType !== ELEMENT) continue;
      const el = child as DomElement;
      const tag = el.tagName.toLowerCase();
      if (shouldRemove(el, tag)) {
        el.remove();
        counts.removedElements++;
        continue;
      }
      const childKeep = isFreeText(el, tag)
        ? false
        : keep || keepsText(el, tag, described);
      const ownText = (el.textContent ?? '').trim().toLowerCase();
      for (const { name, value } of Array.from(el.attributes)) {
        const lower = name.toLowerCase();
        const drop =
          URL_VALUE.test(value) ||
          DROP_ATTRIBUTES.has(lower) ||
          DROP_STATE_ATTRIBUTES.has(lower) ||
          lower.startsWith('on') ||
          (lower.startsWith('data-') && !lower.startsWith('data-test')) ||
          (lower === 'value' && (tag === 'input' || tag === 'textarea')) ||
          (lower === 'aria-label' && !keepsAriaLabel(el, tag));
        if (drop) {
          el.removeAttribute(name);
          counts.droppedAttributes++;
          continue;
        }
        let next = value;
        const blankValue =
          BLANK_ATTRIBUTES.has(lower) ||
          (lower === 'value' &&
            BLANK_VALUE_TAGS.has(tag) &&
            !(childKeep && value.trim().toLowerCase() === ownText));
        if (blankValue) {
          next = blank(value);
          if (next !== value) counts.blankedTexts++;
        }
        next = replaceSecrets(next);
        if (next !== value) el.setAttribute(name, next);
      }
      visit(el, childKeep);
      // An ordinary <template> keeps its markup in a separate fragment.
      if (el.content) visit(el.content, childKeep);
    }
  };
  visit(root, false);

  return { html: document.toString(), counts };
}

/**
 * Every string from the bank that must never reach a snapshot: field values
 * (and the phone number without spaces), facts, answer and variant texts,
 * story titles and texts, and the resume's file name. Strings shorter than 3
 * characters are dropped. Sorted longest first.
 */
export function bankSecrets(bank: FactBank): string[] {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (v.length >= 3) out.add(v);
  };
  const addAll = (value: unknown): void => {
    if (typeof value === 'string') {
      add(value);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) addAll(v);
    }
  };

  addAll(bank.fields);
  add(bank.fields.phone.number.replace(/\s+/g, ''));
  add(bank.fields.phone.full.replace(/\s+/g, ''));
  add(basename(bank.fields.resume.replace(/\\/g, '/')));
  for (const fact of bank.facts) add(fact.text);
  // A one-word answer with no digit or @ (Yes, Immediately) is option wording
  // the form shows to everyone, so it is not a secret.
  const addAnswer = (value: string | undefined): void => {
    if (value === undefined) return;
    const v = value.trim();
    if (/^\S+$/.test(v) && !/\d/.test(v) && !v.includes('@')) return;
    add(v);
  };
  for (const answer of bank.answers) {
    addAnswer(answer.answer);
    for (const variant of answer.variants ?? []) addAnswer(variant.answer);
  }
  for (const story of bank.stories) {
    add(story.title);
    add(story.story);
  }
  add(linkedinSlug(bank));
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * The bank secrets that are names: first, last and full name, and the LinkedIn
 * profile slug. The scrubber matches these inside words.
 */
export function bankNameSecrets(bank: FactBank): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined): void => {
    const t = v?.trim() ?? '';
    if (t.length >= 3) out.add(t);
  };
  add(bank.fields.firstName);
  add(bank.fields.lastName);
  add(bank.fields.fullName);
  add(linkedinSlug(bank));
  return [...out];
}

function linkedinSlug(bank: FactBank): string | undefined {
  const slug = /\/in\/([^/?#\s]+)/.exec(bank.fields.links.linkedin)?.[1];
  if (!slug) return undefined;
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

export type LeakKind = 'email' | 'phone' | 'name' | 'fact' | 'answer' | 'link';
export interface Leak {
  kind: LeakKind;
  count: number;
}

const LEAK_KINDS: LeakKind[] = [
  'email',
  'phone',
  'name',
  'fact',
  'answer',
  'link',
];
/**
 * A fact or answer is searched for only when it has at least this many
 * characters and two words, so option wording (Yes, No, 5) can't count.
 */
const MIN_TEXT_LEAK = 12;
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])';
// Found text is masked with this, which is neither a word character nor a
// phone separator, so a later kind can't count it again.
const MASK = '\u0001';
// Digits with phone separators between them. Each run of digits inside is a
// group; a phone number must be made of whole groups.
const PHONE_SPAN = /\d[\d\s().+-]*\d|\d/g;

const escapeLeak = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const spaced = (s: string) =>
  s.trim().split(/\s+/).map(escapeLeak).join('\\s+');

function textLeakPieces(value: string | undefined): string[] {
  if (value === undefined) return [];
  // A placeholder ({company}) fills in from the job, so only the text around
  // it is the user's.
  return value
    .split(/\{[^}]*\}/)
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter((p) => p.length >= MIN_TEXT_LEAK && /\s/.test(p));
}

function normalizeLink(url: string | undefined): string {
  return (url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/** Patterns come longest value first, so the longest match wins. */
function countAndMask(
  text: string,
  patterns: string[],
): { text: string; count: number } {
  const usable = [...new Set(patterns)];
  if (usable.length === 0) return { text, count: 0 };
  let count = 0;
  const next = text.replace(new RegExp(usable.join('|'), 'giu'), () => {
    count++;
    return MASK;
  });
  return { text: next, count };
}

function phoneForms(bank: FactBank): Set<string> {
  const code = bank.fields.phone.countryCode.replace(/\D/g, '');
  const digits = bank.fields.phone.number.replace(/\D/g, '');
  const national = digits.replace(/^0+/, '');
  const forms = new Set<string>();
  if (national.length < 6) return forms;
  for (const n of [national, `0${national}`]) {
    forms.add(n);
    if (code) {
      forms.add(`${code}${n}`);
      forms.add(`00${code}${n}`);
    }
  }
  return forms;
}

function countPhones(text: string, forms: Set<string>): number {
  if (forms.size === 0) return 0;
  const longest = Math.max(...[...forms].map((f) => f.length));
  let count = 0;
  for (const span of text.match(PHONE_SPAN) ?? []) {
    const groups = span.match(/\d+/g) ?? [];
    let i = 0;
    while (i < groups.length) {
      let joined = '';
      let end = -1;
      for (let j = i; j < groups.length; j++) {
        joined += groups[j];
        if (joined.length > longest) break;
        if (forms.has(joined)) end = j;
      }
      if (end >= 0) {
        count++;
        i = end + 1;
      } else {
        i++;
      }
    }
  }
  return count;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>',
  apos: "'",
};

function decodeEntity(entity: string): string | undefined {
  const lower = entity.toLowerCase();
  if (!lower.startsWith('#')) return NAMED_ENTITIES[lower];
  const code = lower.startsWith('#x')
    ? parseInt(lower.slice(2), 16)
    : parseInt(lower.slice(1), 10);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
  return String.fromCodePoint(code);
}

function decodePercentRun(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    // Not valid UTF-8: decode the ASCII bytes alone, keep the rest as is.
    return run.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
}

/**
 * The text a page shows, as far as a leak goes: HTML entities (numeric, and
 * nbsp, amp, quot, lt, gt, apos) and percent escapes decoded, and every
 * non-breaking space made a plain one. A malformed sequence is left as is.
 */
export function leakText(html: string): string {
  return html
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
      return decodeEntity(e) ?? whole;
    })
    .replace(/(?:%[0-9a-f]{2})+/gi, decodePercentRun)
    .replace(/\u00a0/g, ' ');
}

/**
 * Looks for the bank's personal data in a scrubbed snapshot: the email, the
 * phone number (digits only, with or without its country code and a leading
 * 0, made of whole digit groups so a long id holding the same digits doesn't
 * count), names, facts, answers and stories (12 characters and two words at
 * least), and personal links (without scheme, www or trailing slash), after
 * decoding entities and percent escapes (see leakText). Case is ignored. Returns kinds and counts only, never the text found; empty means
 * clean.
 */
export function leakCheck(scrubbed: string, bank: FactBank): Leak[] {
  const f = bank.fields;
  const counts = new Map<LeakKind, number>();
  let text = leakText(scrubbed);
  const byLength = (values: string[]) =>
    [...values].sort((a, b) => b.length - a.length);
  const run = (kind: LeakKind, patterns: string[]) => {
    const r = countAndMask(text, patterns);
    text = r.text;
    if (r.count > 0) counts.set(kind, (counts.get(kind) ?? 0) + r.count);
  };

  run('email', [
    `(?<![\\p{L}\\p{N}._%+-])${escapeLeak(f.email.trim())}${NOT_WORD_AFTER}`,
  ]);
  run(
    'link',
    byLength(
      [f.links.linkedin, f.links.github, f.links.portfolio, f.links.website]
        .map(normalizeLink)
        .filter((l) => l.length >= 4),
    ).map(
      (l) =>
        `(?<![\\p{L}\\p{N}.-])(?:https?://)?(?:www\\.)?${escapeLeak(l)}(?![\\p{L}\\p{N}_-])`,
    ),
  );
  run(
    'fact',
    byLength(bank.facts.flatMap((fact) => textLeakPieces(fact.text))).map(
      spaced,
    ),
  );
  run(
    'answer',
    byLength([
      ...bank.answers.flatMap((a) => [
        ...textLeakPieces(a.answer),
        ...(a.variants ?? []).flatMap((v) => textLeakPieces(v.answer)),
      ]),
      ...bank.stories.flatMap((s) => [
        ...textLeakPieces(s.title),
        ...textLeakPieces(s.story),
      ]),
    ]).map(spaced),
  );

  const phones = countPhones(text, phoneForms(bank));
  if (phones > 0) counts.set('phone', phones);

  // The full name and the profile slug match inside words (SamExampleCV),
  // a first or last name alone only as a whole word.
  const joined = (s: string) =>
    s
      .split(/[\s_.-]+/)
      .filter((p) => p.length > 0)
      .map(escapeLeak)
      .join('[\\s _.-]*');
  const whole = (s: string) =>
    `${NOT_WORD_BEFORE}${escapeLeak(s)}${NOT_WORD_AFTER}`;
  const single = new Set([f.firstName.trim(), f.lastName.trim()]);
  run(
    'name',
    byLength(bankNameSecrets(bank)).map((n) =>
      single.has(n) ? whole(n) : joined(n),
    ),
  );

  return LEAK_KINDS.filter((k) => counts.has(k)).map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
  }));
}
