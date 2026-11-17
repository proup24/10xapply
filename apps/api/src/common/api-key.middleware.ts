import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Header carrying the shared API key (Node lowercases it). */
export const API_KEY_HEADER = 'x-xapply-key';

/** Compares digests so neither the length nor the content leaks through timing. */
function same(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Requires the shared key on every request, health included. A failure is a
 * plain 401 with a fixed body and no challenge header. It answers directly
 * instead of throwing, because Nest filters do not wrap `app.use` middleware.
 */
export function apiKeyMiddleware(
  expected: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const given = req.headers[API_KEY_HEADER];
    // A repeated header arrives as an array; only a single string counts.
    if (typeof given === 'string' && same(given, expected)) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}
