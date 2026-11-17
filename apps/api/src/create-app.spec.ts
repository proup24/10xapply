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
});
