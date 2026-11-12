import { parseHTML } from 'linkedom';

/** The linkedom document type (the runner has no DOM lib). */
export type Document = ReturnType<typeof parseHTML>['document'];

/**
 * Parses page HTML. Every `<template shadowrootmode=...>` (how the bridge
 * serialises open shadow roots) is replaced by its children in place, so
 * querySelector reaches into shadow content. Ordinary templates are kept.
 */
export function parsePage(html: string): Document {
  const { document } = parseHTML(html);
  // Replacing a template with its children can expose further templates
  // (nested roots), so repeat until none is left.
  for (;;) {
    const template = document.querySelector('template[shadowrootmode]');
    if (!template) break;
    const parent = template.parentNode;
    if (!parent) {
      template.remove();
      continue;
    }
    const content = (template as unknown as { content?: typeof template })
      .content;
    const children = Array.from((content ?? template).childNodes);
    for (const child of children) parent.insertBefore(child, template);
    parent.removeChild(template);
  }
  return document;
}
