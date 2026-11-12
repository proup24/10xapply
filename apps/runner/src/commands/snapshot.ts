import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  FactBankError,
  formatProblem,
  loadFactBank,
  type FactBank,
} from '@xapply/fact-bank';
import { connectBridge } from '../bridge/bridge.js';
import { loadConfig } from '../config.js';
import { pathPrefix } from '../reports/write-report.js';
import {
  RAW_SNAPSHOTS_DIR,
  SCRUBBED_SNAPSHOTS_DIR,
} from '../snapshot/paths.js';
import { bankSecrets, scrubSnapshot } from '../snapshot/scrub.js';
import {
  isAuthorMode,
  nodeTerminal,
  type TerminalIO,
} from '../terminal/author-mode.js';

/** The job id from /jobs/view/<id> or a currentJobId query on a LinkedIn jobs URL. */
export function parseJobUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'linkedin.com' && !u.hostname.endsWith('.linkedin.com')) {
    return null;
  }
  const view = /^\/jobs\/view\/(\d+)(?:\/|$)/.exec(u.pathname);
  if (view) return view[1] ?? null;
  if (u.pathname.startsWith('/jobs/')) {
    const id = u.searchParams.get('currentJobId');
    if (id !== null && /^\d+$/.test(id)) return id;
  }
  return null;
}

export function jobViewUrl(id: string): string {
  return `https://www.linkedin.com/jobs/view/${id}/`;
}

export interface SnapshotPage {
  goto(url: string): Promise<unknown>;
  url(): string;
}

export interface SnapshotBridge {
  openRunWindow(): Promise<SnapshotPage>;
  pageHtml(): Promise<string>;
  stopReason(): string | null;
  close(): Promise<void>;
}

export interface SnapshotDeps {
  author: boolean;
  io: TerminalIO;
  connect(): Promise<SnapshotBridge | { unavailable: string }>;
  rawDir: string;
  scrubbedDir: string;
  now(): Date;
  loadBank(): FactBank;
}

function defaultDeps(): SnapshotDeps {
  return {
    author: isAuthorMode(
      process.env,
      !!process.stdin.isTTY,
      !!process.stdout.isTTY,
    ),
    io: nodeTerminal(),
    connect: async () => {
      const b = await connectBridge(loadConfig());
      if ('unavailable' in b) return b;
      return {
        openRunWindow: async () => {
          const page = await b.openRunWindow();
          return {
            goto: (url: string) =>
              page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
              }),
            url: () => page.url(),
          };
        },
        pageHtml: () => b.pageHtml(),
        stopReason: () => b.stopReason(),
        close: () => b.close(),
      };
    },
    rawDir: RAW_SNAPSHOTS_DIR,
    scrubbedDir: SCRUBBED_SNAPSHOTS_DIR,
    now: () => new Date(),
    loadBank: () => loadFactBank(),
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export async function snapshotCommand(
  argv: string[],
  deps: SnapshotDeps = defaultDeps(),
): Promise<number> {
  const { io } = deps;
  if (!deps.author) {
    io.print('snapshot: run this from your own terminal');
    return 2;
  }
  const id = argv[0] === undefined ? null : parseJobUrl(argv[0]);
  if (id === null) {
    io.print(
      'snapshot: give a LinkedIn job URL (/jobs/view/<id> or currentJobId)',
    );
    return 2;
  }
  const bridge = await deps.connect();
  if ('unavailable' in bridge) {
    io.print(bridge.unavailable);
    return 2;
  }
  let code = 0;
  try {
    const page = await bridge.openRunWindow();
    await page.goto(jobViewUrl(id));
    const dir = join(
      deps.rawDir,
      deps.now().toISOString().replace(/[:.]/g, '-'),
    );
    let n = 0;
    for (;;) {
      const reason = bridge.stopReason();
      if (reason !== null) {
        io.print(`snapshot: stopped: ${reason}`);
        code = 2;
        break;
      }
      const answer = (
        await io.ask('Enter = save this page, q = finish: ')
      ).trim();
      if (answer.toLowerCase() === 'q') break;
      const stopped = bridge.stopReason();
      if (stopped !== null) {
        io.print(`snapshot: stopped: ${stopped}`);
        code = 2;
        break;
      }
      let html: string;
      let prefix: string;
      try {
        html = await bridge.pageHtml();
        prefix = pathPrefix(new URL(page.url()).pathname).replace(/\//g, '');
      } catch {
        io.print('snapshot: could not read the page; it may have closed');
        code = 2;
        break;
      }
      n++;
      const name = `${pad(n)}-${prefix || 'root'}.html`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), html);
      io.print(`saved ${name}`);
    }
  } catch {
    io.print('snapshot: the run window failed');
    code = 2;
  } finally {
    await bridge.close();
  }
  return code;
}

function listHtml(root: string, rel = ''): string[] {
  const here = join(root, rel);
  if (!existsSync(here)) return [];
  const out: string[] = [];
  for (const e of readdirSync(here, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listHtml(root, r));
    else if (e.name.endsWith('.html')) out.push(r);
  }
  return out.sort();
}

/** Scrubs raw files with no scrubbed twin. Prints names and counts, never text. */
export async function snapshotScrubCommand(
  deps: SnapshotDeps = defaultDeps(),
): Promise<number> {
  const { io } = deps;
  let secrets: string[];
  try {
    secrets = bankSecrets(deps.loadBank());
  } catch (e) {
    io.print('snapshot scrub: the fact bank did not load; fix it first');
    if (e instanceof FactBankError) {
      for (const p of e.problems) io.print(`  ${formatProblem(p)}`);
    }
    return 2;
  }
  const todo = listHtml(deps.rawDir).filter(
    (rel) => !existsSync(join(deps.scrubbedDir, rel)),
  );
  for (const rel of todo) {
    const { html, counts } = scrubSnapshot(
      readFileSync(join(deps.rawDir, rel), 'utf8'),
      secrets,
    );
    const target = join(deps.scrubbedDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    io.print(
      `${rel}: removed ${counts.removedElements}, blanked ${counts.blankedTexts}, secrets ${counts.secretsReplaced}, attributes dropped ${counts.droppedAttributes}`,
    );
  }
  io.print(`scrubbed ${todo.length} file(s)`);
  return 0;
}
