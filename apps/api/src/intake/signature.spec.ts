import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from './signature';

const secret = 's3cret';
const body = Buffer.from('{"a":1}');
const ts = 1_800_000_000;
const sign = (s: string, t: number, b: Buffer) =>
  'v1=' + createHmac('sha256', s).update(`${t}.`).update(b).digest('hex');
const sig = sign(secret, ts, body);

const check = (over: Record<string, unknown> = {}) =>
  verifySignature({
    rawBody: body,
    timestamp: String(ts),
    signature: sig,
    secret,
    nowSeconds: ts,
    ...over,
  });

describe('verifySignature', () => {
  it('accepts a valid signature and returns the sent time', () => {
    expect(check()).toEqual({ ok: true, sentAt: new Date(ts * 1000) });
  });

  it('accepts the 5 minute edge on both sides', () => {
    expect(check({ nowSeconds: ts + 300 }).ok).toBe(true);
    expect(check({ nowSeconds: ts - 300 }).ok).toBe(true);
  });

  it('rejects beyond the tolerance', () => {
    expect(check({ nowSeconds: ts + 301 }).ok).toBe(false);
    expect(check({ nowSeconds: ts - 301 }).ok).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(check({ secret: 'other' }).ok).toBe(false);
  });

  it('rejects a changed body', () => {
    expect(check({ rawBody: Buffer.from('{"a":2}') }).ok).toBe(false);
  });

  it('rejects a signature without v1=', () => {
    expect(check({ signature: sig.slice(3) }).ok).toBe(false);
  });

  it('rejects a signature of a different length', () => {
    expect(check({ signature: sig + '00' }).ok).toBe(false);
    expect(check({ signature: sig.slice(0, -2) }).ok).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(check({ timestamp: 'abc' }).ok).toBe(false);
  });

  it('rejects repeated or missing headers', () => {
    expect(check({ timestamp: ['x', 'y'] }).ok).toBe(false);
    expect(check({ signature: ['x', 'y'] }).ok).toBe(false);
    expect(check({ timestamp: undefined }).ok).toBe(false);
    expect(check({ signature: undefined }).ok).toBe(false);
  });
});
