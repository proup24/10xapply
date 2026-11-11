import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'patchright-core';
import { UNAVAILABLE_MESSAGE, connectBridge } from '../bridge/bridge.js';
import type { Bridge } from '../bridge/bridge.js';
import { sittingIdNow } from '../commands/pace.js';
import { loadConfig, type RunnerConfig } from '../config.js';
import { createPace, type Pace } from './pace.js';
import { PACE_DIR } from './paths.js';
import { loadProfile, type PaceProfile } from './profile.js';
import { createWriter, type Writer } from './writer.js';

const answers = JSON.parse(
  readFileSync(
    new URL('./fixtures/practice-answers.json', import.meta.url),
    'utf8',
  ),
) as {
  phoneCountry: number;
  phone: string;
  years: string;
  authorised: number;
  relocate: number;
  why: string;
};

/** A 1-byte file; the practice page never reads it. */
export const RESUME_PATH = fileURLToPath(
  new URL('./fixtures/resume.pdf', import.meta.url),
);

/**
 * One run of the local practice form, in the order a person fills it:
 * the long description first, then each of the four steps.
 * The optional extras come from `pace.maybe`.
 */
export async function runPractice(
  pace: Pace,
  page: Page,
  run: number,
): Promise<void> {
  const $ = (selector: string) => page.locator(selector);

  if (pace.maybe('expand-description')) await pace.click($('#more'));
  await pace.read((await $('#job-details').textContent())?.length ?? null);
  await pace.click($('#apply'));
  await pace.pause();

  // Step 1: contact. The email is prefilled.
  await pace.glance($('#email'));
  await pace.pick($('#phone-country'), answers.phoneCountry);
  await pace.type($('#phone'), answers.phone);
  await pace.pause();
  await pace.click($('#next'));
  await pace.pause();

  // Step 2: resume.
  await pace.upload($('#upload'), RESUME_PATH);
  await pace.pause();
  await pace.type($('#years'), answers.years);
  await pace.pause();
  await pace.click($('[data-step="2"] .next'));
  await pace.pause();

  // Step 3: questions.
  await pace.pick($('fieldset:has(input[name="auth"])'), answers.authorised);
  await pace.pause();
  await pace.pick($('fieldset:has(input[name="relocate"])'), answers.relocate);
  await pace.pause();
  await pace.type($('#why'), answers.why);
  await pace.pause();
  await pace.click($('#follow'));
  await pace.pause();
  await pace.click($('#review'));
  await pace.pause();

  // Step 4: review.
  await pace.click($('#submit'));
  if (!(await $('#done').isVisible())) {
    throw new Error(`practice run ${run}: the form did not confirm`);
  }
}

export interface PracticeDeps {
  cfg?: RunnerConfig;
  connect?: typeof connectBridge;
  loadProfile?: () => PaceProfile;
  createPace?: typeof createPace;
  createWriter?: (sittingId: string) => Writer;
  out?: (text: string) => void;
}

/** Runs the practice form `runs` times through the bridge. Never touches LinkedIn. */
export async function practiceCommand(
  opts: { runs?: number; record?: boolean; deps?: PracticeDeps } = {},
): Promise<number> {
  const deps = opts.deps ?? {};
  const runs = Math.max(1, Math.floor(opts.runs ?? 5));
  const out = deps.out ?? ((t: string) => void console.log(t));
  const cfg = deps.cfg ?? loadConfig();
  // Throws a ConfigError when there is no profile: nothing to run without it.
  const profile = (deps.loadProfile ?? (() => loadProfile()))();
  const bridge: Bridge | { unavailable: string } = await (
    deps.connect ?? connectBridge
  )(cfg);
  if ('unavailable' in bridge) {
    out(bridge.unavailable || UNAVAILABLE_MESSAGE);
    return 2;
  }

  const sittingId = sittingIdNow();
  const writer = opts.record
    ? (deps.createWriter?.(sittingId) ??
      createWriter({ dir: PACE_DIR, actor: 'runner', sittingId }))
    : null;
  let done = 0;
  let page: Page | undefined;
  let offBatches: (() => void) | undefined;
  try {
    if (writer) {
      offBatches = bridge.onRecorderBatch((b) => writer.add(b));
      await bridge.startRecording(randomBytes(16).toString('hex'));
    }
    page = await bridge.openRunWindow();
    for (let run = 1; run <= runs; run++) {
      const reason = bridge.stopReason();
      if (reason) {
        out(`stopped: ${reason}`);
        break;
      }
      await page.goto(
        `http://127.0.0.1:${cfg.relayPort}/practice/?run=${run}`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );
      const pace = (deps.createPace ?? createPace)(page, profile, {
        viewport: () => bridge.viewport(),
      });
      if (run === 1 && pace.defaulted.length > 0) {
        out(`defaulted measures: ${pace.defaulted.join(', ')}`);
      }
      await runPractice(pace, page, run);
      done++;
      out(`practice run ${run}/${runs} done`);
    }
  } catch (e) {
    out(
      `practice stopped: ${bridge.stopReason() ?? (e instanceof Error ? e.message : 'failed')}`,
    );
  } finally {
    offBatches?.();
    if (writer) await bridge.stopRecording().catch(() => undefined);
    try {
      await page?.close();
    } catch {
      // ignore
    }
    await bridge.close();
  }
  if (writer) {
    try {
      const paths = writer.flush();
      out(paths.length ? paths.join('\n') : 'no recordings written');
    } catch {
      out('recordings could not be written');
    }
  }
  return done === runs ? 0 : 2;
}
