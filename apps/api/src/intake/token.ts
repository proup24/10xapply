import { createHash } from 'node:crypto';

/** SHA-256 hex of an intake token. Only the hash is stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
