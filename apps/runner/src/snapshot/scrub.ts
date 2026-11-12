import { basename } from 'node:path';
import type { FactBank } from '@xapply/fact-bank';
import { parsePage } from '../linkedin/dom.js';

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
]);
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * remaining text or attribute value that holds a secret has it replaced.
 */
export function scrubSnapshot(
  html: string,
  secrets: string[],
): { html: string; counts: ScrubCounts } {
  const document = parsePage(html);
  const counts: ScrubCounts = {
    removedElements: 0,
    blankedTexts: 0,
    secretsReplaced: 0,
    droppedAttributes: 0,
  };

  const usable = [
    ...new Set(secrets.map((s) => s.trim()).filter((s) => s.length > 0)),
  ].sort((a, b) => b.length - a.length);
  const secretPattern =
    usable.length > 0
      ? new RegExp(usable.map(escapeRegex).join('|'), 'gi')
      : undefined;
  const replaceSecrets = (value: string): string => {
    if (!secretPattern) return value;
    return value.replace(secretPattern, () => {
      counts.secretsReplaced++;
      return '[secret]';
    });
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
          next = text.replace(/\S/g, 'x');
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
      for (const { name, value } of Array.from(el.attributes)) {
        const lower = name.toLowerCase();
        const drop =
          DROP_ATTRIBUTES.has(lower) ||
          lower.startsWith('on') ||
          (lower.startsWith('data-') && !lower.startsWith('data-test')) ||
          (lower === 'value' && (tag === 'input' || tag === 'textarea')) ||
          (lower === 'aria-label' && !keepsAriaLabel(el, tag));
        if (drop) {
          el.removeAttribute(name);
          counts.droppedAttributes++;
          continue;
        }
        const next = replaceSecrets(value);
        if (next !== value) el.setAttribute(name, next);
      }
      const childKeep = keep || keepsText(el, tag, described);
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
  for (const answer of bank.answers) {
    add(answer.answer);
    for (const variant of answer.variants ?? []) add(variant.answer);
  }
  for (const story of bank.stories) {
    add(story.title);
    add(story.story);
  }
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}
