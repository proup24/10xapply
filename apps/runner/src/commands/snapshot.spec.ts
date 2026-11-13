import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactBankError, loadFactBank } from '@xapply/fact-bank';
import { describe, expect, it } from 'vitest';
import {
  snapshotCommand,
  snapshotScrubCommand,
  type SnapshotBridge,
  type SnapshotDeps,
} from './snapshot.js';

const EXAMPLE_BANK = loadFactBank(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'libs',
    'fact-bank',
    'fact-bank.example.yaml',
  ),
);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'snap-'));
}

function fakeBridge(
  log: string[],
  pages: string[],
  stop: () => string | null = () => null,
) {
  let closed = 0;
  const bridge: SnapshotBridge = {
    openRunWindow: async () => ({
      goto: async (u: string) => {
        log.push(`goto ${u}`);
      },
      url: () => 'https://www.linkedin.com/jobs/view/1/',
    }),
    pageHtml: async () => pages.shift() ?? '<p>none</p>',
    stopReason: stop,
    close: async () => {
      closed++;
    },
  };
  return { bridge, closed: () => closed };
}

function io(answers: string[], out: string[]) {
  return {
    print: (l: string) => void out.push(l),
    ask: async (p: string) => {
      out.push(p);
      return answers.shift() ?? 'q';
    },
  };
}

function deps(over: Partial<SnapshotDeps>): SnapshotDeps {
  return {
    author: true,
    io: io([], []),
    connect: async () => ({ unavailable: 'no' }),
    rawDir: tmp(),
    scrubbedDir: tmp(),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
    loadBank: () => EXAMPLE_BANK,
    ...over,
  };
}

describe('snapshotCommand', () => {
  it('refuses outside author mode', async () => {
    const out: string[] = [];
    const code = await snapshotCommand(
      ['https://www.linkedin.com/jobs/view/1/'],
      deps({ author: false, io: io([], out) }),
    );
    expect(code).toBe(2);
    expect(out).toEqual(['snapshot: run this from your own terminal']);
  });

  it('refuses a bad URL', async () => {
    expect(await snapshotCommand(['https://example.com/'], deps({}))).toBe(2);
    expect(await snapshotCommand([], deps({}))).toBe(2);
  });

  it('saves one file per Enter and finishes on q', async () => {
    const log: string[] = [];
    const out: string[] = [];
    const f = fakeBridge(log, ['<p>one</p>', '<p>two</p>']);
    const rawDir = tmp();
    const code = await snapshotCommand(
      ['https://www.linkedin.com/jobs/view/1/'],
      deps({
        rawDir,
        io: io(['', '', 'q'], out),
        connect: async () => f.bridge,
      }),
    );
    expect(code).toBe(0);
    expect(log).toEqual(['goto https://www.linkedin.com/jobs/view/1/']);
    const run = readdirSync(rawDir)[0] ?? '';
    const files = readdirSync(join(rawDir, run)).sort();
    expect(files).toEqual(['01-jobs.html', '02-jobs.html']);
    expect(readFileSync(join(rawDir, run, '02-jobs.html'), 'utf8')).toBe(
      '<p>two</p>',
    );
    expect(out.join('\n')).toContain('01-jobs.html');
    expect(f.closed()).toBe(1);
  });

  it('stops on the bridge stop reason and closes', async () => {
    const out: string[] = [];
    let n = 0;
    const f = fakeBridge([], [], () => (n++ > 0 ? 'detached' : null));
    const code = await snapshotCommand(
      ['https://www.linkedin.com/jobs/view/1/'],
      deps({ io: io(['', '', ''], out), connect: async () => f.bridge }),
    );
    expect(code).toBe(2);
    expect(f.closed()).toBe(1);
  });

  it('reports an unavailable bridge', async () => {
    const out: string[] = [];
    const code = await snapshotCommand(
      ['https://www.linkedin.com/jobs/view/1/'],
      deps({ io: io([], out) }),
    );
    expect(code).toBe(2);
    expect(out).toEqual(['no']);
  });
});

describe('snapshotScrubCommand', () => {
  it('writes twins only for new raw files and prints counts, never text', async () => {
    const rawDir = tmp();
    const scrubbedDir = tmp();
    mkdirSync(join(rawDir, 'run1'));
    writeFileSync(
      join(rawDir, 'run1', '01-jobs.html'),
      `<body><p>${EXAMPLE_BANK.fields.fullName}</p><script>x</script></body>`,
    );
    writeFileSync(
      join(rawDir, 'run1', '02-jobs.html'),
      '<body><p>hello</p></body>',
    );
    mkdirSync(join(scrubbedDir, 'run1'));
    writeFileSync(join(scrubbedDir, 'run1', '02-jobs.html'), 'KEEP');
    const out: string[] = [];
    const code = await snapshotScrubCommand(
      deps({
        rawDir,
        scrubbedDir,
        io: io([], out),
        author: false,
      }),
    );
    expect(code).toBe(0);
    expect(
      readFileSync(join(scrubbedDir, 'run1', '02-jobs.html'), 'utf8'),
    ).toBe('KEEP');
    const scrubbed = readFileSync(
      join(scrubbedDir, 'run1', '01-jobs.html'),
      'utf8',
    );
    expect(scrubbed).not.toContain(EXAMPLE_BANK.fields.fullName);
    const text = out.join('\n');
    expect(text).toContain('run1/01-jobs.html');
    expect(text).not.toContain(EXAMPLE_BANK.fields.fullName);
    expect(text).not.toContain('hello');
  });

  it('refuses when the bank does not load', async () => {
    const out: string[] = [];
    const rawDir = tmp();
    const err = new FactBankError([{ where: 'fields.x', message: 'is wrong' }]);
    const code = await snapshotScrubCommand(
      deps({
        rawDir,
        io: io([], out),
        loadBank: () => {
          throw err;
        },
      }),
    );
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('fields.x: is wrong');
  });

  it('is fine with no raw dir', async () => {
    const out: string[] = [];
    const code = await snapshotScrubCommand(
      deps({ rawDir: join(tmp(), 'nope'), io: io([], out) }),
    );
    expect(code).toBe(0);
  });
});
