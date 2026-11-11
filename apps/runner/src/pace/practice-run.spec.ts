import type { Locator, Page } from 'patchright-core';
import type { Bridge } from '../bridge/bridge.js';
import type { Pace } from './pace.js';
import { practiceCommand, runPractice, RESUME_PATH } from './practice-run.js';
import { testProfile } from './testing/profiles.js';
import type { Writer } from './writer.js';
import { existsSync, statSync } from 'node:fs';

const sel = (l: unknown) => (l as { sel: string }).sel;

function fakes(opts: { expand?: boolean; confirmed?: boolean } = {}) {
  const calls: string[] = [];
  const page = {
    locator: (s: string) =>
      ({
        sel: s,
        textContent: async () => 'x'.repeat(300),
        isVisible: async () => opts.confirmed ?? true,
      }) as unknown as Locator,
  } as unknown as Page;
  const rec =
    (name: string) =>
    async (...a: unknown[]) => {
      calls.push(
        `${name}(${a.map((x) => (typeof x === 'object' && x ? sel(x) : String(x))).join(', ')})`,
      );
    };
  const pace = {
    mood: 1,
    defaulted: [],
    click: rec('click'),
    type: rec('type'),
    glance: rec('glance'),
    pick: rec('pick'),
    upload: rec('upload'),
    read: rec('read'),
    pause: rec('pause'),
    scroll: rec('scroll'),
    maybe: (a: string) => {
      calls.push(`maybe(${a})`);
      return opts.expand ?? false;
    },
  } as unknown as Pace;
  Object.assign(pace, { calls });
  return { page, pace, calls };
}

describe('runPractice', () => {
  it('runPractice uses every field kind once', async () => {
    const { page, pace, calls } = fakes({ expand: true });
    await runPractice(pace, page, 1);
    const acts = calls.filter((c) => !c.startsWith('pause'));
    expect(acts).toEqual([
      'maybe(expand-description)',
      'click(#more)',
      'read(300)',
      'click(#apply)',
      'glance(#email)',
      'pick(#phone-country, 1)',
      'type(#phone, 5550142)',
      'click(#next)',
      `upload(#upload, ${RESUME_PATH})`,
      'type(#years, 6)',
      'click([data-step="2"] .next)',
      'pick(fieldset:has(input[name="auth"]), 0)',
      'pick(fieldset:has(input[name="relocate"]), 1)',
      expect.stringMatching(/^type\(#why, /),
      'click(#follow)',
      'click(#review)',
      'click(#submit)',
    ]);
  });

  it('skips the expand click when maybe says no', async () => {
    const { page, pace, calls } = fakes({ expand: false });
    await runPractice(pace, page, 1);
    expect(calls).not.toContain('click(#more)');
  });

  it('fails when the form does not confirm', async () => {
    const { page, pace } = fakes({ confirmed: false });
    await expect(runPractice(pace, page, 2)).rejects.toThrow(
      'practice run 2: the form did not confirm',
    );
  });

  it('ships a 1-byte resume fixture', () => {
    expect(existsSync(RESUME_PATH)).toBe(true);
    expect(statSync(RESUME_PATH).size).toBe(1);
  });
});

describe('practiceCommand', () => {
  function setup(runs: number) {
    const urls: string[] = [];
    const order: string[] = [];
    const { page, pace } = fakes();
    (page as unknown as { goto: unknown }).goto = async (u: string) =>
      void urls.push(u);
    (page as unknown as { close: unknown }).close = async () => undefined;
    const bridge = {
      openRunWindow: async () => page,
      stopReason: () => null,
      viewport: async () => ({ width: 1280, height: 800 }),
      uploadOnChooser: vi.fn(async (_f: string, open: () => Promise<void>) =>
        open(),
      ),
      startRecording: async () => void order.push('start'),
      stopRecording: async () => void order.push('stop'),
      onRecorderBatch: () => () => undefined,
      close: async () => undefined,
    } as unknown as Bridge;
    const writer: Writer = {
      add: () => undefined,
      counts: () => ({ pages: 0, clicks: 0, keyGaps: 0, wheels: 0 }),
      flush: () => {
        order.push('flush');
        return ['/pace/runner/practice/S-none.json'];
      },
    };
    let output = '';
    const createWriter = vi.fn(() => writer);
    const createPace = vi.fn(() => pace);
    const run = (record: boolean) =>
      practiceCommand({
        runs,
        record,
        deps: {
          cfg: { relayPort: 9444, token: 't' },
          connect: (async () => bridge) as never,
          loadProfile: () => testProfile(),
          resumeFile: () => 'C:\\L\\10xapply\\practice-resume.pdf',
          createPace: createPace as never,
          createWriter,
          out: (t) => void (output += `${t}\n`),
        },
      });
    return {
      run,
      urls,
      order,
      bridge,
      calls: () => (pace as unknown as { calls: string[] }).calls,
      createWriter,
      createPace,
      out: () => output,
    };
  }

  it('runs the practice form the requested number of times', async () => {
    const s = setup(3);
    expect(await s.run(false)).toBe(0);
    expect(s.urls).toEqual([
      'http://127.0.0.1:9444/practice/?run=1',
      'http://127.0.0.1:9444/practice/?run=2',
      'http://127.0.0.1:9444/practice/?run=3',
    ]);
    expect(s.createPace).toHaveBeenCalledTimes(3);
    expect(s.createWriter).not.toHaveBeenCalled();
  });

  it('uploads the Windows-side file through the bridge', async () => {
    const s = setup(1);
    expect(await s.run(false)).toBe(0);
    expect(s.calls()).toContain(
      'upload(#upload, C:\\L\\10xapply\\practice-resume.pdf)',
    );
    const pdeps = (
      s.createPace.mock.calls[0] as unknown as [
        unknown,
        unknown,
        {
          uploadOnChooser: (f: string, o: () => Promise<void>) => Promise<void>;
        },
      ]
    )[2];
    const open = vi.fn(async () => undefined);
    await pdeps.uploadOnChooser('C:\\f.pdf', open);
    expect(s.bridge.uploadOnChooser).toHaveBeenCalledWith('C:\\f.pdf', open);
    expect(open).toHaveBeenCalledOnce();
  });

  it('--record records as the runner and flushes after stopping', async () => {
    const s = setup(1);
    await s.run(true);
    expect(s.order).toEqual(['start', 'stop', 'flush']);
    expect(s.out()).toContain('/pace/runner/practice/S-none.json');
  });

  it('throws without a profile', async () => {
    await expect(
      practiceCommand({
        deps: {
          cfg: { relayPort: 9444, token: 't' },
          loadProfile: () => {
            throw new Error('no pace profile');
          },
        },
      }),
    ).rejects.toThrow('no pace profile');
  });
});
