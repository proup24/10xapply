import {
  assertLocalDatabase,
  captureRemoteOptIn,
  isLocalUrl,
} from './local-guard.js';

describe('isLocalUrl', () => {
  it.each([
    'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
    'postgresql://u:p@localhost:55322/db',
    'http://127.0.0.1:55321',
    'http://[::1]:55321',
  ])('treats %s as local', (url) => expect(isLocalUrl(url)).toBe(true));

  it('treats a pooler URL as remote', () =>
    expect(
      isLocalUrl(
        'postgresql://postgres.ref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
      ),
    ).toBe(false));
});

describe('assertLocalDatabase', () => {
  const remote = 'postgresql://u:secret@db.example.com:5432/x';

  it('refuses a remote URL and names the variable and host', () =>
    expect(() => assertLocalDatabase({ DATABASE_URL: remote }, {})).toThrow(
      /DATABASE_URL.*db\.example\.com.*XAPPLY_ALLOW_REMOTE_DB=1/,
    ));

  it('never prints the password', () =>
    expect(() => assertLocalDatabase({ DATABASE_URL: remote }, {})).not.toThrow(
      /secret/,
    ));

  it('allows a remote URL with XAPPLY_ALLOW_REMOTE_DB=1', () =>
    expect(() =>
      assertLocalDatabase(
        { DATABASE_URL: remote },
        { XAPPLY_ALLOW_REMOTE_DB: '1' },
      ),
    ).not.toThrow());

  it('ignores undefined URLs', () =>
    expect(() =>
      assertLocalDatabase({ DIRECT_DATABASE_URL: undefined }, {}),
    ).not.toThrow());
});

describe('guard bypass attempts', () => {
  const remote = 'postgresql://u:secret@db.example.com:5432/x';
  const local = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

  it.each([
    'postgresql://u:p@localhost:55322/db?host=db.example.com',
    'postgresql://u:p@localhost:55322/db?hostaddr=10.0.0.5',
    'postgresql://u:p@localhost:55322/db?host=/var/run/postgresql',
    'postgresql://u:p@localhost:55322/db?host=localhost,db.example.com',
    'postgresql://u:p@LOCALHOST.evil.com:55322/db',
    'postgresql://u:p@localhost.evil.com:55322/db',
    'postgresql://u:p@127.0.0.2:55322/db',
    'not a url',
  ])('treats %s as remote', (url) => expect(isLocalUrl(url)).toBe(false));

  it('names the host from a host query parameter', () =>
    expect(() =>
      assertLocalDatabase(
        {
          DATABASE_URL:
            'postgresql://u:p@localhost:55322/db?host=db.example.com',
        },
        {},
      ),
    ).toThrow(/DATABASE_URL.*db\.example\.com/));

  it('allows a local host query parameter', () =>
    expect(
      isLocalUrl('postgresql://u:p@localhost:55322/db?host=127.0.0.1'),
    ).toBe(true));

  it('refuses an unparseable URL naming <unparseable>', () =>
    expect(() =>
      assertLocalDatabase({ DATABASE_URL: 'not a url' }, {}),
    ).toThrow(/DATABASE_URL.*<unparseable>/));

  it('refuses a remote DIRECT_DATABASE_URL next to a local DATABASE_URL', () =>
    expect(() =>
      assertLocalDatabase(
        { DATABASE_URL: local, DIRECT_DATABASE_URL: remote },
        {},
      ),
    ).toThrow(/DIRECT_DATABASE_URL.*db\.example\.com/));
});

describe('captureRemoteOptIn', () => {
  const remote = 'postgresql://u:secret@db.example.com:5432/x';

  it('ignores an opt-in that only arrives after the snapshot (env file load)', () => {
    const env: NodeJS.ProcessEnv = {};
    const optIn = captureRemoteOptIn(env);
    env.XAPPLY_ALLOW_REMOTE_DB = '1'; // what loading a .env would do
    expect(() => assertLocalDatabase({ DATABASE_URL: remote }, optIn)).toThrow(
      /XAPPLY_ALLOW_REMOTE_DB=1/,
    );
  });

  it('keeps an opt-in present before the snapshot', () => {
    const optIn = captureRemoteOptIn({ XAPPLY_ALLOW_REMOTE_DB: '1' });
    expect(() =>
      assertLocalDatabase({ DATABASE_URL: remote }, optIn),
    ).not.toThrow();
  });

  it('copies only the opt-in variable', () =>
    expect(
      captureRemoteOptIn({ FOO: 'bar', XAPPLY_ALLOW_REMOTE_DB: '1' }),
    ).toEqual({
      XAPPLY_ALLOW_REMOTE_DB: '1',
    }));
});

describe('brief cases', () => {
  const pw =
    'postgresql://u:secretpw@aws-0-eu.pooler.supabase.com:5432/postgres';
  it('treats 127.0.0.1, localhost and ::1 as local', () => {
    expect(
      isLocalUrl('postgresql://postgres:postgres@127.0.0.1:55322/postgres'),
    ).toBe(true);
    expect(isLocalUrl('postgresql://p:p@localhost:55322/postgres')).toBe(true);
    expect(isLocalUrl('postgresql://p:p@[::1]:55322/postgres')).toBe(true);
  });
  it('treats a host query parameter as a target', () =>
    expect(
      isLocalUrl('postgresql://u:p@127.0.0.1:55322/db?host=db.example.com'),
    ).toBe(false));
  it('refuses a remote URL without the opt-in, naming only variable and host', () => {
    let message = '';
    try {
      assertLocalDatabase({ DATABASE_URL: pw }, {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(
      /DATABASE_URL at non-local host aws-0-eu\.pooler\.supabase\.com.*XAPPLY_ALLOW_REMOTE_DB=1/,
    );
    expect(message).not.toContain('secretpw');
  });
  it('allows a remote URL with XAPPLY_ALLOW_REMOTE_DB=1', () =>
    expect(() =>
      assertLocalDatabase(
        { DATABASE_URL: pw },
        { XAPPLY_ALLOW_REMOTE_DB: '1' },
      ),
    ).not.toThrow());
});

describe('ports of the local stack', () => {
  it.each([
    // 10xjobs's local stack, and the Postgres and HTTP defaults
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'postgresql://postgres:postgres@localhost:54322/postgres',
    'http://127.0.0.1:54321',
    'http://[::1]:54321',
    'postgresql://u:p@localhost:5432/db',
    'postgresql://u:p@localhost/db',
    'http://localhost',
    'postgresql://u:p@127.0.0.1:55320/postgres',
    // a port query parameter overrides the authority's
    'postgresql://u:p@127.0.0.1:55322/db?port=54322',
    'postgresql://u:p@127.0.0.1:55322/db?port=55322,54322',
  ])('refuses %s', (url) => expect(isLocalUrl(url)).toBe(false));

  it("allows a port query parameter that is the stack's own", () =>
    expect(isLocalUrl('postgresql://u:p@127.0.0.1:55322/db?port=55322')).toBe(
      true,
    ));

  it('names the variable, host and port, never the password', () => {
    let message = '';
    try {
      assertLocalDatabase(
        {
          DATABASE_URL:
            'postgresql://postgres:secretpw@127.0.0.1:54322/postgres',
        },
        {},
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(
      /DATABASE_URL at 127\.0\.0\.1:54322.*55321 and 55322.*XAPPLY_ALLOW_REMOTE_DB=1/,
    );
    expect(message).not.toContain('secretpw');
  });

  it('names a missing port as the default', () =>
    expect(() =>
      assertLocalDatabase({ SUPABASE_URL: 'http://localhost' }, {}),
    ).toThrow(/SUPABASE_URL at localhost:default/));

  it('allows another port with the opt-in', () =>
    expect(() =>
      assertLocalDatabase(
        { DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres' },
        { XAPPLY_ALLOW_REMOTE_DB: '1' },
      ),
    ).not.toThrow());

  it("accepts CI's and .env.example's URLs", () =>
    expect(() =>
      assertLocalDatabase(
        {
          DATABASE_URL:
            'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
          SUPABASE_URL: 'http://127.0.0.1:55321',
        },
        {},
      ),
    ).not.toThrow());
});
