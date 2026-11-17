import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Header carrying the shared API key (Node lowercases it). */
export const API_KEY_HEADER = 'x-xapply-key';

/** Compares digests so neither the length nor the content leaks through timing. */
function same(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const INTAKE_PATH = /^\/api\/intake\/[^/]+$/;

/**
 * True only for a POST to exactly one segment under /api/intake. `path` is the
 * full request path without the query string. A trailing slash, a deeper path
 * and a different case all fail the match and so still need the key.
 */
export function isIntakePost(method: string, path: string): boolean {
  return method === 'POST' && INTAKE_PATH.test(path);
}

/**
 * Requires the shared key on every request, health included, except the
 * intake POST, which carries its own token and signature. A failure is a
 * plain 401 with a fixed body and no challenge header. It answers directly
 * instead of throwing, because Nest filters do not wrap `app.use` middleware.
 */
export function apiKeyMiddleware(
  expected: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (isIntakePost(req.method, req.path)) {
      next();
      return;
    }
    const given = req.headers[API_KEY_HEADER];
    // A repeated header arrives as an array; only a single string counts.
    if (typeof given === 'string' && same(given, expected)) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}
