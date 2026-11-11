/** Hides relay tokens (and a known token value) before a message is printed. */
export function redact(message: string, token?: string): string {
  let out = message.replace(/token=[^\s&"'#]+/gi, 'token=<redacted>');
  if (token) out = out.split(token).join('<redacted>');
  return out;
}
