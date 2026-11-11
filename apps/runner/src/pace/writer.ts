import { join } from 'node:path';
import { writeAtomic } from './paths.js';
import type {
  Actor,
  Ctx,
  PageInfo,
  RecordedEvent,
  RecorderBatch,
  Recording,
  Source,
} from './recording.js';

export interface Counts {
  pages: number;
  clicks: number;
  keyGaps: number;
  wheels: number;
}

/** Where a page's recording is filed, from its path alone. */
export function sourceFromCtx(ctx: Ctx): Source {
  const p = ctx.path;
  if (p.startsWith('/practice')) return 'practice';
  if (p.startsWith('/typing')) return 'typing';
  if (p.startsWith('/jobs')) return 'linkedin';
  return 'test-page';
}

export interface WriterOptions {
  dir: string;
  actor: Actor;
  source?: (ctx: Ctx) => Source;
  sittingId: string;
}

export interface Writer {
  add(b: RecorderBatch): void;
  counts(): Counts;
  /** Writes one file per source and jobKey; returns the paths. */
  flush(): string[];
}

interface Group {
  source: Source;
  jobKey: string;
  pages: PageInfo[];
  events: RecordedEvent[];
}

export function createWriter(opts: WriterOptions): Writer {
  const sourceOf = opts.source ?? sourceFromCtx;
  const groups = new Map<string, Group>();
  const pageIds = new Set<string>();
  const lastKeydown = new Map<string, boolean>();
  const counts: Counts = { pages: 0, clicks: 0, keyGaps: 0, wheels: 0 };

  return {
    add(b) {
      const ctx = b.events[0]?.ctx ?? b.page?.ctx;
      if (!ctx) return;
      const source = sourceOf(ctx);
      const jobKey = b.jobKey ?? 'none';
      const id = `${source}\0${jobKey}`;
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { source, jobKey, pages: [], events: [] }));
      if (b.page) g.pages.push(b.page);
      g.events.push(...b.events);

      pageIds.add(b.pageId);
      counts.pages = pageIds.size;
      for (const e of b.events) {
        if (e.type === 'click') counts.clicks++;
        else if (e.type === 'wheel') counts.wheels++;
        else if (e.type === 'keydown') {
          // A gap is the time between two keydowns on the same page.
          if (lastKeydown.get(b.pageId)) counts.keyGaps++;
          lastKeydown.set(b.pageId, true);
        }
      }
    },

    counts: () => ({ ...counts }),

    flush() {
      const paths: string[] = [];
      for (const g of groups.values()) {
        const recording: Recording = {
          version: 1,
          actor: opts.actor,
          source: g.source,
          sittingId: opts.sittingId,
          jobKey: g.jobKey,
          pages: g.pages,
          events: g.events,
        };
        const path = join(
          opts.dir,
          opts.actor,
          g.source,
          `${opts.sittingId}-${g.jobKey.replace(/[^\w.-]/g, '_')}.json`,
        );
        writeAtomic(path, JSON.stringify(recording));
        paths.push(path);
      }
      return paths;
    },
  };
}
