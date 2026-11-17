import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { AppModule } from '../app.module';
import type { Environment } from '../config/environment';
import { APP_OPTIONS, configureApp, createApp } from '../create-app';
import type { DatabaseClient } from '@xapply/database';
import { DatabaseService } from '../database/database.service';
import { IntakeRepository } from './intake.repository';
import { createTestUser, localDatabaseUrl } from './testing/local-db';
import { hashToken } from './token';

const SECRET = 's3cret';
const DB_ERROR = 'db-failure-detail-that-must-not-be-logged';

/** Collects every line the app logs, at any level. */
class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(...args: unknown[]): void {
    this.lines.push(args.map((a) => String(a)).join(' '));
  }
  log(...args: unknown[]): void {
    this.push(...args);
  }
  error(...args: unknown[]): void {
    this.push(...args);
  }
  warn(...args: unknown[]): void {
    this.push(...args);
  }
  debug(...args: unknown[]): void {
    this.push(...args);
  }
  verbose(...args: unknown[]): void {
    this.push(...args);
  }
  fatal(...args: unknown[]): void {
    this.push(...args);
  }
}

const env: Environment = {
  API_KEY: 'fake-test-key-'.padEnd(40, 'x'),
  PORT: 3000,
  NODE_ENV: 'test',
  DATABASE_URL: localDatabaseUrl(),
};

const logger = new CaptureLogger();
const createdUsers: string[] = [];
let pool: pg.Pool;
let app: NestExpressApplication;
let failingApp: NestExpressApplication;
let rollbackApp: NestExpressApplication;
let base: string;
let failingBase: string;
let rollbackBase: string;
/** Set when the rollback app's delivery insert returned its row, inside the transaction. */
let rollbackDeliveryInserted = false;

const urlOf = (a: NestExpressApplication) =>
  `http://127.0.0.1:${(a.getHttpServer().address() as AddressInfo).port}`;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: localDatabaseUrl() });
  app = await createApp(env, { logger });
  await app.listen(0, '127.0.0.1');
  base = urlOf(app);

  failingApp = await appWithRepository((database) => {
    const repo = new IntakeRepository(database);
    repo.store = () => Promise.reject(new Error(DB_ERROR));
    return repo;
  });
  failingBase = urlOf(failingApp);

  // The real store and its real transaction, with the match insert (the
  // transaction's second query, after the delivery insert) failing.
  rollbackApp = await appWithRepository(
    (database) =>
      new IntakeRepository({
        db: failingSecondQuery(database.db),
      } as unknown as DatabaseService),
  );
  rollbackBase = urlOf(rollbackApp);
});

/** An app whose IntakeRepository the factory builds. */
async function appWithRepository(
  factory: (database: DatabaseService) => IntakeRepository,
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(env)],
  })
    .overrideProvider(IntakeRepository)
    .useFactory({ factory, inject: [DatabaseService] })
    .compile();
  const built = moduleRef.createNestApplication<NestExpressApplication>({
    ...APP_OPTIONS,
    logger,
  });
  configureApp(built, env);
  await built.listen(0, '127.0.0.1');
  return built;
}

/** A method bound to its target, so a proxy never changes `this`. */
function bound(target: object, prop: string | symbol): unknown {
  const value: unknown = Reflect.get(target, prop);
  return typeof value === 'function' ? value.bind(target) : value;
}

/**
 * The real client, except that inside a transaction the second `query` (the
 * match insert) throws once the first (the delivery insert) has run.
 */
function failingSecondQuery(db: DatabaseClient): DatabaseClient {
  type Tx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
  const wrapTx = (tx: Tx): Tx => {
    let queries = 0;
    return new Proxy(tx, {
      get(target, prop) {
        if (prop !== 'query') return bound(target, prop);
        return async (...args: Parameters<Tx['query']>) => {
          queries += 1;
          if (queries > 1) throw new Error(DB_ERROR);
          const rows = await target.query(...args);
          rollbackDeliveryInserted = rows.length === 1;
          return rows;
        };
      },
    });
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'transaction') return bound(target, prop);
      return (
        fn: Parameters<DatabaseClient['transaction']>[0],
        ...rest: unknown[]
      ) =>
        (target.transaction as (...a: unknown[]) => unknown)(
          (tx: Tx) => fn(wrapTx(tx)),
          ...rest,
        );
    },
  });
}

afterAll(async () => {
  await app?.close();
  await failingApp?.close();
  await rollbackApp?.close();
  if (createdUsers.length > 0) {
    // Cascades to public.users, and from there to links, deliveries and matches.
    await pool.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [
      createdUsers,
    ]);
  }
  await pool?.end();
});

type User = { userId: string; token: string };

async function newUser(secret = SECRET): Promise<User> {
  const userId = await createTestUser();
  createdUsers.push(userId);
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    'INSERT INTO intake_links ("userId", "tokenHash", secret) VALUES ($1, $2, $3)',
    [userId, hashToken(token), secret],
  );
  return { userId, token };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const sign = (body: string, ts: number, secret = SECRET) =>
  'v1=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

function payload(
  deliveryId: string,
  job: { id?: string; key?: string; postingUrl?: string } = {},
) {
  return {
    version: 1,
    event: 'match.qualified',
    deliveryId,
    createdAt: '2026-11-16T10:00:00.000Z',
    profile: {
      id: 'p1',
      position: 'backend_engineer',
      label: 'Backend engineer',
    },
    trigger: 'decision',
    match: { id: 'm1', unverified: false, stackScore: 0.72, reasons: [] },
    job: {
      id: job.id ?? 'j1',
      key: job.key ?? 'linkedin-job:4488500594',
      title: 'Senior Backend Engineer',
      company: { name: 'Acme', url: 'https://acme.example' },
      postingUrl:
        job.postingUrl ?? 'https://www.linkedin.com/jobs/view/4488500594/',
      applyUrl: null,
    },
  };
}

type Send = {
  token: string;
  body?: string;
  deliveryId?: string;
  event?: string;
  ts?: number;
  secret?: string;
  signature?: string;
  omit?: string[];
  contentType?: string;
  url?: string;
};

async function send(o: Send): Promise<Response> {
  const deliveryId = o.deliveryId ?? randomUUID();
  const ts = o.ts ?? nowSeconds();
  const body = o.body ?? JSON.stringify(payload(deliveryId));
  const headers: Record<string, string> = {
    'content-type': o.contentType ?? 'application/json',
    'x-10xjobs-event': o.event ?? 'match.qualified',
    'x-10xjobs-delivery': deliveryId,
    'x-10xjobs-timestamp': String(ts),
    'x-10xjobs-signature': o.signature ?? sign(body, ts, o.secret),
  };
  for (const name of o.omit ?? []) delete headers[name];
  return fetch(`${o.url ?? base}/api/intake/${o.token}`, {
    method: 'POST',
    headers,
    body: body === '' ? undefined : body,
  });
}

async function deliveries(userId: string) {
  const { rows } = await pool.query<{
    deliveryId: string;
    event: string;
    outcome: string;
    rawBody: string;
    sentAt: Date;
  }>(
    'SELECT "deliveryId", event, outcome, "rawBody", "sentAt" FROM webhook_deliveries WHERE "userId" = $1 ORDER BY "createdAt", id',
    [userId],
  );
  return rows;
}

async function matches(userId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM matches WHERE "userId" = $1 ORDER BY "createdAt", id',
    [userId],
  );
  return rows;
}

async function expectOk(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"ok":true}');
}

async function expectUnauthorized(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(await res.text()).toBe('{"error":"unauthorized"}');
}

describe('POST /api/intake/:token', () => {
  it('stores a match and answers 200 {"ok":true}', async () => {
    const { userId, token } = await newUser();
    const deliveryId = randomUUID();
    const ts = nowSeconds();
    // Odd whitespace: the signature is over the exact bytes, not re-serialized JSON.
    const body = `  ${JSON.stringify(payload(deliveryId), null, 3)}\n\t `;
    await expectOk(await send({ token, deliveryId, ts, body }));

    const ds = await deliveries(userId);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      deliveryId,
      event: 'match.qualified',
      outcome: 'match',
      rawBody: body,
      sentAt: new Date(ts * 1000),
    });
    const ms = await matches(userId);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({
      deliveryId,
      xjobsJobId: 'j1',
      jobKey: 'linkedin-job:4488500594',
      linkedinJobId: '4488500594',
      title: 'Senior Backend Engineer',
      companyName: 'Acme',
      postingUrl: 'https://www.linkedin.com/jobs/view/4488500594/',
      applyUrl: null,
      profileLabel: 'Backend engineer',
      unverified: false,
      matchedAt: new Date('2026-11-16T10:00:00.000Z'),
      status: 'new',
    });
  });

  it('answers 200 and writes nothing for a repeated delivery id', async () => {
    const { userId, token } = await newUser();
    const deliveryId = randomUUID();
    const ts = nowSeconds();
    const body = JSON.stringify(payload(deliveryId));
    await expectOk(await send({ token, deliveryId, ts, body }));
    await expectOk(await send({ token, deliveryId, ts, body }));
    expect(await deliveries(userId)).toHaveLength(1);
    expect(await matches(userId)).toHaveLength(1);
  });

  it('marks a second delivery for the same job.id duplicate-job', async () => {
    const { userId, token } = await newUser();
    const a = randomUUID();
    const b = randomUUID();
    await expectOk(
      await send({ token, deliveryId: a, body: JSON.stringify(payload(a)) }),
    );
    // Same job.id, another LinkedIn id: only the job.id key collides.
    const body = JSON.stringify(
      payload(b, {
        key: 'linkedin-job:4490505838',
        postingUrl: 'https://www.linkedin.com/jobs/view/4490505838/',
      }),
    );
    await expectOk(await send({ token, deliveryId: b, body }));
    const ds = await deliveries(userId);
    expect(ds.map((d) => [d.deliveryId, d.outcome])).toEqual([
      [a, 'match'],
      [b, 'duplicate-job'],
    ]);
    expect(await matches(userId)).toHaveLength(1);
  });

  it('marks a new job.id with a stored LinkedIn id duplicate-job', async () => {
    const { userId, token } = await newUser();
    const a = randomUUID();
    const b = randomUUID();
    await expectOk(
      await send({ token, deliveryId: a, body: JSON.stringify(payload(a)) }),
    );
    const body = JSON.stringify(payload(b, { id: 'j2' }));
    await expectOk(await send({ token, deliveryId: b, body }));
    expect((await deliveries(userId)).map((d) => d.outcome)).toEqual([
      'match',
      'duplicate-job',
    ]);
    const ms = await matches(userId);
    expect(ms).toHaveLength(1);
    expect(ms[0]?.['xjobsJobId']).toBe('j1');
  });

  it('stores a greenhouse job with a null LinkedIn id', async () => {
    const { userId, token } = await newUser();
    const job = (id: string) => ({
      id,
      key: 'ats:greenhouse/acme/1',
      postingUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    });
    const a = randomUUID();
    const b = randomUUID();
    await expectOk(
      await send({
        token,
        deliveryId: a,
        body: JSON.stringify(payload(a, job('g1'))),
      }),
    );
    await expectOk(
      await send({
        token,
        deliveryId: b,
        body: JSON.stringify(payload(b, job('g2'))),
      }),
    );
    const ms = await matches(userId);
    expect(ms.map((m) => [m['xjobsJobId'], m['linkedinJobId']])).toEqual([
      ['g1', null],
      ['g2', null],
    ]);
    expect((await deliveries(userId)).map((d) => d.outcome)).toEqual([
      'match',
      'match',
    ]);
  });

  it('records a test event without a match', async () => {
    const { userId, token } = await newUser();
    const deliveryId = randomUUID();
    const body = JSON.stringify({ ...payload(deliveryId), event: 'test' });
    await expectOk(await send({ token, deliveryId, event: 'test', body }));
    const ds = await deliveries(userId);
    expect(ds.map((d) => [d.event, d.outcome])).toEqual([['test', 'test']]);
    expect(await matches(userId)).toHaveLength(0);
  });

  it('takes the kind from the signed body: a test body under a match header is unparsed', async () => {
    const { userId, token } = await newUser();
    const deliveryId = randomUUID();
    const body = JSON.stringify({ ...payload(deliveryId), event: 'test' });
    await expectOk(
      await send({ token, deliveryId, event: 'match.qualified', body }),
    );
    const ds = await deliveries(userId);
    // The stored event column keeps the header's value.
    expect(ds.map((d) => [d.event, d.outcome])).toEqual([
      ['match.qualified', 'unparsed'],
    ]);
    expect(await matches(userId)).toHaveLength(0);
  });

  it('takes the kind from the signed body: a match body under a test header is unparsed', async () => {
    const { userId, token } = await newUser();
    const deliveryId = randomUUID();
    const body = JSON.stringify(payload(deliveryId));
    await expectOk(await send({ token, deliveryId, event: 'test', body }));
    expect((await deliveries(userId)).map((d) => d.outcome)).toEqual([
      'unparsed',
    ]);
    expect(await matches(userId)).toHaveLength(0);
  });

  it('stores an unparsed delivery for a signed non-JSON body', async () => {
    const { userId, token } = await newUser();
    await expectOk(
      await send({ token, body: 'not json', contentType: 'text/plain' }),
    );
    const ds = await deliveries(userId);
    expect(ds.map((d) => [d.outcome, d.rawBody])).toEqual([
      ['unparsed', 'not json'],
    ]);
    expect(await matches(userId)).toHaveLength(0);
  });

  it('stores a match whose title holds an escaped NUL, without the NUL', async () => {
    const { userId, token } = await newUser();
    const deliveryId = randomUUID();
    const p = payload(deliveryId);
    p.job.title = 'a\u0000b';
    const body = JSON.stringify(p);
    expect(body).toContain('"title":"a\\u0000b"');
    await expectOk(await send({ token, deliveryId, body }));
    expect((await deliveries(userId)).map((d) => d.outcome)).toEqual(['match']);
    expect((await matches(userId)).map((m) => m['title'])).toEqual(['ab']);
  });

  it('stores an unparsed delivery for a signed body with a raw NUL byte', async () => {
    const { userId, token } = await newUser();
    const body = 'not\u0000json';
    await expectOk(await send({ token, body, contentType: 'text/plain' }));
    const ds = await deliveries(userId);
    expect(ds.map((d) => [d.outcome, d.rawBody])).toEqual([
      ['unparsed', 'not\uFFFDjson'],
    ]);
  });

  it('stores an unparsed delivery for a signed request with no body', async () => {
    const { userId, token } = await newUser();
    await expectOk(await send({ token, body: '' }));
    const ds = await deliveries(userId);
    expect(ds.map((d) => [d.outcome, d.rawBody])).toEqual([['unparsed', '']]);
  });

  it('answers 401 for an unknown token, a wrong signature and a stale timestamp (now − 301 s)', async () => {
    const { userId, token } = await newUser();
    await expectUnauthorized(
      await send({ token: randomBytes(32).toString('base64url') }),
    );
    await expectUnauthorized(await send({ token, secret: 'wrong' }));
    await expectUnauthorized(await send({ token, ts: nowSeconds() - 301 }));
    await expectUnauthorized(await send({ token, signature: 'v1=00' }));
    expect(await deliveries(userId)).toHaveLength(0);
    expect(await matches(userId)).toHaveLength(0);
  });

  it.each([
    'x-10xjobs-timestamp',
    'x-10xjobs-signature',
    'x-10xjobs-delivery',
    'x-10xjobs-event',
  ])('answers 401 when %s is missing, writing nothing', async (name) => {
    const { userId, token } = await newUser();
    await expectUnauthorized(await send({ token, omit: [name] }));
    expect(await deliveries(userId)).toHaveLength(0);
  });

  it('answers 401 for a repeated delivery header, writing nothing', async () => {
    const { userId, token } = await newUser();
    const ts = nowSeconds();
    const body = '{}';
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${base}/api/intake/${token}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-10xjobs-event': 'test',
            // An array sends the header twice.
            'x-10xjobs-delivery': [randomUUID(), randomUUID()],
            'x-10xjobs-timestamp': String(ts),
            'x-10xjobs-signature': sign(body, ts),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe(401);
    expect(await deliveries(userId)).toHaveLength(0);
  });

  it('keeps users apart', async () => {
    const a = await newUser('secret-a');
    const b = await newUser('secret-b');
    await expectUnauthorized(
      await send({ token: b.token, secret: 'secret-a' }),
    );
    expect(await deliveries(a.userId)).toHaveLength(0);
    expect(await deliveries(b.userId)).toHaveLength(0);
    // The same delivery id is independent per user.
    const deliveryId = randomUUID();
    const body = JSON.stringify(payload(deliveryId));
    await expectOk(
      await send({ token: a.token, secret: 'secret-a', deliveryId, body }),
    );
    await expectOk(
      await send({ token: b.token, secret: 'secret-b', deliveryId, body }),
    );
    expect(await deliveries(a.userId)).toHaveLength(1);
    expect(await deliveries(b.userId)).toHaveLength(1);
    expect(await matches(a.userId)).toHaveLength(1);
    expect(await matches(b.userId)).toHaveLength(1);
  });

  it('answers 500 when the database fails', async () => {
    const { userId, token } = await newUser();
    const deliveryId = randomUUID();
    const from = logger.lines.length;
    const res = await send({ token, deliveryId, url: failingBase });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal"}');
    expect(await deliveries(userId)).toHaveLength(0);
    const logged = logger.lines.slice(from).join('\n');
    expect(logged).toContain(`intake: ${deliveryId} error 500`);
    expect(logged).not.toContain(DB_ERROR);
  });

  it('rolls the delivery back when the match insert fails, and a retry stores it', async () => {
    const { userId, token } = await newUser();
    const deliveryId = randomUUID();
    const ts = nowSeconds();
    const body = JSON.stringify(payload(deliveryId));
    const from = logger.lines.length;
    rollbackDeliveryInserted = false;

    const res = await send({ token, deliveryId, ts, body, url: rollbackBase });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal"}');
    // The delivery row was written inside the transaction, then rolled back.
    expect(rollbackDeliveryInserted).toBe(true);
    expect(await deliveries(userId)).toHaveLength(0);
    expect(await matches(userId)).toHaveLength(0);
    const logged = logger.lines.slice(from).join('\n');
    expect(logged).toContain(`intake: ${deliveryId} error 500`);
    expect(logged).not.toContain(DB_ERROR);

    // 10xjobs's retry: the same signed request, to a working repository.
    await expectOk(await send({ token, deliveryId, ts, body }));
    const ds = await deliveries(userId);
    expect(ds.map((d) => [d.deliveryId, d.outcome])).toEqual([
      [deliveryId, 'match'],
    ]);
    expect(await matches(userId)).toHaveLength(1);
  });

  it('logs no secret', async () => {
    const { token } = await newUser();
    const deliveryId = randomUUID();
    const from = logger.lines.length;
    await expectOk(await send({ token, deliveryId }));
    await expectUnauthorized(await send({ token, secret: 'wrong' }));
    const logged = logger.lines.slice(from);
    expect(logged).toEqual([
      expect.stringContaining(`intake: ${deliveryId} match 200`),
      expect.stringContaining('intake: unauthorized'),
    ]);
    const text = logged.join('\n');
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashToken(token));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('v1=');
    expect(text).not.toContain('Backend engineer');
  });
});
