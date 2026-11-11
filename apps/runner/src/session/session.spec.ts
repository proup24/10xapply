import {
  FEED_URL,
  runSession,
  type SessionDeps,
  type SessionPage,
} from './session.js';

function fake(
  over: Partial<SessionPage> = {},
  deps: Partial<SessionDeps> = {},
) {
  const page: SessionPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    path: vi.fn().mockReturnValue('/feed/'),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  let t = 1_000;
  const d: SessionDeps = {
    openPage: async () => page,
    stopReason: () => null,
    wait: vi.fn().mockResolvedValue(undefined),
    randomInt: vi.fn((min: number) => min),
    now: () => (t += 10),
    ...deps,
  };
  return { page, d };
}

describe('runSession', () => {
  it('signed in', async () => {
    const { page, d } = fake();
    const r = await runSession(d);
    expect(r.result).toBe('signed-in');
    expect(r.pathPrefix).toBe('/feed/');
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(FEED_URL);
    expect(page.close).toHaveBeenCalled();
  });

  it('reports only the first path segment', async () => {
    const { d } = fake({ path: () => '/in/some-handle/' });
    const r = await runSession(d);
    expect(r.result).toBe('unexpected-page');
    expect(JSON.stringify(r)).not.toContain('some-handle');
  });

  it('stopped mid-load', async () => {
    const { page, d } = fake(
      {
        goto: vi.fn().mockRejectedValue(new Error('closed')),
        close: vi.fn().mockRejectedValue(new Error('boom')),
      },
      { stopReason: () => 'debugger detached: canceled_by_user' },
    );
    const r = await runSession(d);
    expect(r.result).toBe('stopped');
    expect(r.stopReason).toBe('debugger detached: canceled_by_user');
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalled();
  });

  it('navigation error without stop', async () => {
    const { d } = fake({
      goto: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    const r = await runSession(d);
    expect(r.result).toBe('unexpected-page');
    expect(r.stopReason).toBeUndefined();
  });

  it('stop reason set during the wait wins over classification', async () => {
    let stop: string | null = null;
    const { d } = fake(
      {},
      {
        stopReason: () => stop,
        wait: async () => {
          stop = 'run window minimized';
        },
      },
    );
    const r = await runSession(d);
    expect(r.result).toBe('stopped');
    expect(r.stopReason).toBe('run window minimized');
  });

  it('waits are random within bounds', async () => {
    const { d } = fake();
    await runSession(d);
    expect(d.randomInt).toHaveBeenCalledWith(4000, 8000);
    expect(d.randomInt).toHaveBeenCalledWith(1500, 4000);
  });

  it('openPage rejects with a stop reason: stopped, no close', async () => {
    const { page, d } = fake(
      {},
      {
        openPage: async () => {
          throw new Error('gone');
        },
        stopReason: () => 'extension disconnected',
      },
    );
    const r = await runSession(d);
    expect(r.result).toBe('stopped');
    expect(r.stopReason).toBe('extension disconnected');
    expect(r.pathPrefix).toBeNull();
    expect(page.close).not.toHaveBeenCalled();
  });

  it('openPage rejects without a stop reason: unexpected-page', async () => {
    const { d } = fake(
      {},
      {
        openPage: async () => {
          throw new Error('gone');
        },
      },
    );
    const r = await runSession(d);
    expect(r.result).toBe('unexpected-page');
    expect(r.pathPrefix).toBeNull();
  });
});
