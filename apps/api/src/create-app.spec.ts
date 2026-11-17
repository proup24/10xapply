import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from './create-app';

const key = 'fake-test-key-'.padEnd(40, 'x');
let app: NestExpressApplication;
let base: string;

beforeAll(async () => {
  app = await createApp(
    {
      API_KEY: key,
      PORT: 3000,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db',
    },
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

const withKey = { headers: { 'x-xapply-key': key } };

describe('createApp', () => {
  it('GET /api/health with the key answers 503 {"status":"database-unreachable"} when the database is down', async () => {
    const res = await fetch(`${base}/api/health`, withKey);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'database-unreachable' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /api/health without the key answers 401', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"unauthorized"}');
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('GET /api/nope answers 401 without the key and 404 with it', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(401);
    expect((await fetch(`${base}/api/nope`, withKey)).status).toBe(404);
  });

  it('sends no x-powered-by header', async () => {
    const res = await fetch(`${base}/api/health`, withKey);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  // The intake route looks the token up first, so with the database down a
  // request that got past the key check answers the route's own 500.
  it('POST /api/intake/some-token without the key gets past the key check', async () => {
    const res = await fetch(`${base}/api/intake/some-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal"}');
  });

  it('keeps the decision when a query string is added', async () => {
    const post = await fetch(`${base}/api/intake/abc?x=1`, { method: 'POST' });
    expect(post.status).toBe(500);
    expect((await fetch(`${base}/api/intake/abc?x=1`)).status).toBe(401);
  });

  it('GET /api/intake/x without the key answers 401', async () => {
    expect((await fetch(`${base}/api/intake/x`)).status).toBe(401);
  });

  it.each([
    '/api/intake/abc/',
    '/api/intake/abc/def',
    '/api/intake/',
    '/api/intake',
    '/api/intakex/abc',
    '/API/INTAKE/abc',
  ])('POST %s without the key answers 401', async (path) => {
    const res = await fetch(`${base}${path}`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('POST /api/intake/a%2Fb without the key is one segment and passes the key check', async () => {
    const res = await fetch(`${base}/api/intake/a%2Fb`, { method: 'POST' });
    expect(res.status).toBe(500);
  });

  it('POST to another route without the key answers 401', async () => {
    const res = await fetch(`${base}/api/health`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('a body over 1 MB on the intake route answers 413', async () => {
    const res = await fetch(`${base}/api/intake/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.text()).toBe('{"error":"payload-too-large"}');
  });

  it('a body that fails to decode on the intake route answers 400 JSON without a stack', async () => {
    const res = await fetch(`${base}/api/intake/abc`, {
      method: 'POST',
      headers: { 'content-encoding': 'gzip' },
      body: 'not gzip',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.text()).toBe('{"error":"bad-request"}');
  });
});
