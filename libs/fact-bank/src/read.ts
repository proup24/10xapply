import { isAlias, parseDocument, visit } from 'yaml';
import type { Problem } from './problems.js';

export function readYaml(text: string): { raw?: unknown; problems: Problem[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const doc = parseDocument(source, { schema: 'failsafe', uniqueKeys: true });
  const problems: Problem[] = [];

  // Only the position is reported; the parser's message can quote the file.
  for (const err of doc.errors) {
    const pos = err.linePos?.[0];
    problems.push({
      where: pos ? `line ${pos.line}, column ${pos.col}` : 'file',
      message: 'YAML syntax error',
    });
  }

  let anchored = false;
  visit(doc, {
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
