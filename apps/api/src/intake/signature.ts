import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

export type SignatureResult = { ok: true; sentAt: Date } | { ok: false };

/**
 * Verifies 10xjobs's `X-10xjobs-Signature` (see 10xjobs's docs/webhooks.md).
 * `timestamp` and `signature` are the raw header values: anything but a single
 * string fails. Never logs.
 */
export function verifySignature(input: {
  rawBody: Buffer;
  timestamp: unknown;
  signature: unknown;
  secret: string;
  nowSeconds: number;
}): SignatureResult {
  const { rawBody, timestamp, signature, secret, nowSeconds } = input;
  if (typeof timestamp !== 'string' || typeof signature !== 'string') {
    return { ok: false };
  }
  if (timestamp.trim() === '') return { ok: false };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false };
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return { ok: false };

  const expected = Buffer.from(
    'v1=' +
      createHmac('sha256', secret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest('hex'),
  );
  const received = Buffer.from(signature);
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return { ok: false };
  }
  return { ok: true, sentAt: new Date(ts * 1000) };
}
