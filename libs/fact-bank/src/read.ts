import { isAlias, isScalar, LineCounter, parseDocument, visit } from 'yaml';
import type { Problem } from './problems.js';

export function readYaml(text: string): { raw?: unknown; problems: Problem[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lineCounter = new LineCounter();
  // logLevel 'error' keeps the parser from printing warnings, which can quote
  // the file.
  const doc = parseDocument(source, {
    schema: 'failsafe',
    uniqueKeys: true,
    logLevel: 'error',
    lineCounter,
  });
  const problems: Problem[] = [];

  // Only the position is reported; the parser's message can quote the file.
  // Only the first error: one bad line can make the parser cascade.
  const first = doc.errors[0];
  if (first) {
    const pos = first.linePos?.[0];
    problems.push({
      where: pos ? `line ${pos.line}, column ${pos.col}` : 'file',
      message: 'YAML syntax error',
    });
  }

  let anchored = false;
  visit(doc, {
    Pair(_key, pair) {
      if (isScalar(pair.key)) return;
      const offset = (pair.key as { range?: [number, number, number] } | null)
        ?.range?.[0];
      const pos =
        offset === undefined ? undefined : lineCounter.linePos(offset);
      problems.push({
        where: pos ? `line ${pos.line}, column ${pos.col}` : 'file',
        message: 'keys must be plain text',
      });
    },
    Node(_key, node) {
      if (isAlias(node) || (node as { anchor?: string }).anchor) {
        anchored = true;
      }
    },
  });
  if (anchored) {
    problems.push({
      where: 'file',
      message: 'YAML anchors and aliases are not allowed',
    });
  }

  return problems.length > 0 ? { problems } : { raw: doc.toJS(), problems };
}
