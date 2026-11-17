import type { NextFunction, Request, Response } from 'express';
import { apiKeyMiddleware, isIntakePost } from './api-key.middleware';

const expected = 'fake-test-key-'.padEnd(40, 'x');

function run(
  headers: Record<string, string | string[]>,
  method = 'GET',
  path = '/api/health',
) {
  const next = vi.fn();
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  };
  apiKeyMiddleware(expected)(
    { headers, method, path } as unknown as Request,
    res as unknown as Response,
    next as NextFunction,
  );
  return { next, res };
}

function expectUnauthorized(r: ReturnType<typeof run>) {
  expect(r.next).not.toHaveBeenCalled();
  expect(r.res.status).toHaveBeenCalledWith(401);
  expect(r.res.json).toHaveBeenCalledWith({ error: 'unauthorized' });
}

describe('apiKeyMiddleware', () => {
  it('calls next for the right key', () => {
    const r = run({ 'x-xapply-key': expected });
    expect(r.next).toHaveBeenCalledOnce();
    expect(r.res.status).not.toHaveBeenCalled();
  });

  it('401 for no header', () => {
    expectUnauthorized(run({}));
  });

  it('401 for a wrong key of the same length', () => {
    expectUnauthorized(run({ 'x-xapply-key': 'y'.repeat(expected.length) }));
  });

  it('401 for a key of a different length', () => {
    expectUnauthorized(run({ 'x-xapply-key': 'short' }));
  });

  it('401 for a repeated header (array)', () => {
    expectUnauthorized(run({ 'x-xapply-key': [expected, expected] }));
  });

  it('the 401 body is exactly {"error":"unauthorized"} and never contains the sent key', () => {
    const sent = 'sent-fake-key-value';
    const r = run({ 'x-xapply-key': sent });
    expectUnauthorized(r);
    expect(JSON.stringify(r.res.json.mock.calls)).not.toContain(sent);
    expect(r.res.setHeader).not.toHaveBeenCalled();
  });
});

describe('isIntakePost', () => {
  it('is true only for POST to one segment under /api/intake', () => {
    expect(isIntakePost('POST', '/api/intake/abc')).toBe(true);
    expect(isIntakePost('POST', '/api/intake/a%2Fb')).toBe(true);
  });

  it.each([
    ['GET', '/api/intake/abc'],
    ['POST', '/api/intake/abc/x'],
    ['POST', '/api/intake/abc/'],
    ['POST', '/api/intake/'],
    ['POST', '/api/intake'],
    ['POST', '/api/intakex/abc'],
    ['POST', '/api/health'],
  ])('is false for %s %s', (method, path) => {
    expect(isIntakePost(method, path)).toBe(false);
  });
});

describe('apiKeyMiddleware on the intake route', () => {
  it('calls next without the key for POST /api/intake/abc', () => {
    const r = run({}, 'POST', '/api/intake/abc');
    expect(r.next).toHaveBeenCalledOnce();
    expect(r.res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/intake/abc'],
    ['POST', '/api/intake/abc/x'],
    ['POST', '/api/intake/'],
    ['POST', '/api/intakex/abc'],
    ['POST', '/api/health'],
  ])('401 without the key for %s %s', (method, path) => {
    expectUnauthorized(run({}, method, path));
  });
});
