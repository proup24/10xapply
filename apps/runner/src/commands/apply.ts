import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Locator, Page } from 'patchright-core';
import {
  answerQuestion,
  createClaudeCliCaller,
  type ModelCaller,
} from '@xapply/answerer';
import {
  DEFAULT_RULES_PATH,
  RulesError,
  extractFromJob,
  extractFromQuestions,
  loadRules,
  type Rules,
} from '@xapply/disqualify';
import {
  addKnownAnswer,
  DEFAULT_FACT_BANK_PATH,
  FactBankError,
  formatProblem,
  loadFactBank,
  type FactBank,
} from '@xapply/fact-bank';
import { ReadMismatchError, type Resume } from '../apply/fill.js';
import {
  formatRedactedSummary,
  formatRunMarkdown,
  redactApplyRun,
  writeApplyReports,
} from '../apply/report.js';
import { INTERRUPTED, runApply } from '../apply/run.js';
import type { ApplyDeps, ApplyPage, ApplyRun } from '../apply/types.js';
import { connectBridge, type Bridge } from '../bridge/bridge.js';
import { installResume, realExec } from '../bridge/install.js';
import {
  loadAnswerConfig,
  loadConfig,
  type AnswerConfig,
  type RunnerConfig,
} from '../config.js';
import { clean } from '../linkedin/el.js';
import { parseJobUrl } from '../linkedin/job-url.js';
import { createPace } from '../pace/pace.js';
import { loadProfile, type PaceProfile } from '../pace/profile.js';
import { isAuthorMode, nodeTerminal } from '../terminal/author-mode.js';

export const NO_DRY_RUN = 'apply: submitting comes in slice 07; use --dry-run';
const BAD_URL =
  'apply: give a LinkedIn job URL (/jobs/view/<id> or currentJobId); quote a long URL';
const NO_BANK = 'apply: the fact bank did not load; fix it first';
const NO_RULES = 'apply: the disqualify rules did not load; fix them first';
const NO_RESUME =
  "apply: the fact bank's resume file is missing; run pnpm nx run runner:facts-check";
export const RESUME_FAILED = 'apply: could not install the resume';
export const REPORTS_FAILED = 'apply: could not write the reports';

/** How long a typeahead gets to show the answer, and how often it's read. */
const SUGGESTION_WAIT_MS = 5_000;
const SUGGESTION_POLL_MS = 250;
/** A read of one field: it is on the page already, so this is short. */
const READ_TIMEOUT_MS = 5_000;
/**
 * Fill reads (values and checked state) give up after this: a selector the
 * page re-rendered away should fail the fill fast, not wait 5 s.
 */
const FILL_READ_TIMEOUT_MS = 1_000;

export interface ApplyCommandDeps {
  authorMode: boolean;
  out: (text: string) => void;
  bankPath: string;
  loadBank: (path: string) => FactBank;
  rulesPath: string;
  loadRules: (path: string) => Rules;
  installResume: (bankResumePath: string) => Resume;
  loadConfig: () => RunnerConfig;
  loadAnswerConfig: () => AnswerConfig;
  loadProfile: () => PaceProfile;
  connect: (cfg: RunnerConfig) => Promise<Bridge | { unavailable: string }>;
  createPace: typeof createPace;
  caller: () => ModelCaller;
  runApply: (jobId: string, deps: ApplyDeps) => Promise<ApplyRun>;
  writeReports: (
    run: ApplyRun,
    bank: FactBank,
  ) => { full: string; redacted: string };
  /** Adds a SIGINT listener; returns its removal. */
  onSigint: (fn: () => void) => () => void;
  /** A second Ctrl+C. */
  exit: (code: number) => void;
  now: () => Date;
}

function defaultDeps(): ApplyCommandDeps {
  return {
    authorMode: isAuthorMode(
      process.env,
      process.stdin.isTTY === true,
      process.stdout.isTTY === true,
    ),
    out: (t) => void console.log(t),
    bankPath: DEFAULT_FACT_BANK_PATH,
    loadBank: (p) => loadFactBank(p),
    rulesPath: DEFAULT_RULES_PATH,
    loadRules: (p) => loadRules(p),
    installResume: (p) => installResume(p, realExec),
    loadConfig: () => loadConfig(),
    loadAnswerConfig: () => loadAnswerConfig(),
    loadProfile: () => loadProfile(),
    connect: (cfg) => connectBridge(cfg),
    createPace,
    caller: () => createClaudeCliCaller(),
    runApply,
    writeReports: (run, bank) => writeApplyReports(run, bank),
    onSigint: (fn) => {
      process.on('SIGINT', fn);
      return () => void process.off('SIGINT', fn);
    },
    exit: (code) => process.exit(code),
    now: () => new Date(),
  };
}

/** The local date as YYYY-MM-DD. */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A CSS attribute value in double quotes. */
const quoted = (s: string): string =>
  `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * The run tab as the walker sees it. Reads only, through locators: no
 * script runs in the page, and every input goes through pace.
 */
export function adaptApplyPage(
  page: Page,
  bridge: Pick<Bridge, 'pageHtml'>,
  wait: (ms: number) => Promise<void> = (ms) => sleep(ms),
): ApplyPage {
  const optionsOf = (list: string) => page.locator(`${list} [role="option"]`);
  const textAt = async (sel: Locator): Promise<string> =>
    clean((await sel.textContent({ timeout: READ_TIMEOUT_MS })) ?? '');

  /**
   * The selector of the option reading `want` (cleaned, any case), or
   * null. It is anchored on that text, never on a position, so a list that
   * reorders meanwhile still gets the right option clicked. An option's id
   * is used only if the element it names still reads `want` when re-read.
   */
  const matchingOption = async (
    list: string,
    want: string,
  ): Promise<string | null> => {
    const options = optionsOf(list);
    const n = await options.count();
    for (let k = 0; k < n; k++) {
      const text = await textAt(options.nth(k));
      if (text.toLowerCase() !== want) continue;
      const id = await options
        .nth(k)
        .getAttribute('id', { timeout: READ_TIMEOUT_MS });
      if (id) {
        const byId = `${list} [id=${quoted(id)}]`;
        if ((await textAt(page.locator(byId))).toLowerCase() === want) {
          return byId;
        }
      }
      return `${list} [role="option"]:text-is(${quoted(text)})`;
    }
    return null;
  };
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    },
    path: () => new URL(page.url()).pathname,
    html: () => bridge.pageHtml(),
    close: () => page.close(),
    locator: (sel) => page.locator(sel),
    value: (sel) =>
      page.locator(sel).inputValue({ timeout: FILL_READ_TIMEOUT_MS }),
    checked: (sel) =>
      page.locator(sel).isChecked({ timeout: FILL_READ_TIMEOUT_MS }),
    anyChecked: async (sel) => {
      const inputs = page.locator(sel);
      const n = await inputs.count();
      if (n === 0) throw new ReadMismatchError('nothing matches');
      for (let i = 0; i < n; i++) {
        const on = await inputs
          .nth(i)
          .isChecked({ timeout: FILL_READ_TIMEOUT_MS });
        if (on) return true;
      }
      return false;
    },
    checkedAt: async (sel, index, count) => {
      const inputs = page.locator(sel);
      if ((await inputs.count()) !== count) {
        throw new ReadMismatchError('the inputs changed');
      }
      return inputs.nth(index).isChecked({ timeout: FILL_READ_TIMEOUT_MS });
    },
    idAt: async (sel, index, count) => {
      const inputs = page.locator(sel);
      if ((await inputs.count()) !== count) {
        throw new ReadMismatchError('the inputs changed');
      }
      return inputs
        .nth(index)
        .getAttribute('id', { timeout: FILL_READ_TIMEOUT_MS });
    },
    selectedText: async (sel) => {
      const chosen = page.locator(sel).locator('option:checked');
      if ((await chosen.count()) === 0) return null;
      const text = await chosen
        .first()
        .textContent({ timeout: FILL_READ_TIMEOUT_MS });
      return text === null ? null : clean(text);
    },
    suggestion: async (list, text) => {
      const want = clean(text).toLowerCase();
      const tries = Math.ceil(SUGGESTION_WAIT_MS / SUGGESTION_POLL_MS);
      for (let i = 0; i <= tries; i++) {
        const found = await matchingOption(list, want);
        if (found !== null) return found;
        if (i < tries) await wait(SUGGESTION_POLL_MS);
      }
      return null;
    },
  };
}

/**
 * A fixed line for a failure. The error's own message can quote a path or
 * bank text, so only the author sees it.
 */
function failed(d: ApplyCommandDeps, line: string, e: unknown): void {
  d.out(line);
  if (d.authorMode && e instanceof Error) d.out(`  ${e.message}`);
}

function unavailableRun(jobId: string, startedAt: Date, why: string): ApplyRun {
  return {
    jobId,
    startedAt: startedAt.toISOString(),
    outcome: 'bridge-unavailable',
    stop: { kind: 'bridge', step: null, detail: why, pathPrefix: null },
    job: null,
    questions: [],
    unknownFields: [],
    checks: [],
    disqualification: null,
    timings: { totalMs: 0, perStepMs: [] },
  };
}

/**
 * `runner apply <job-url> --dry-run`: walks one job's Easy Apply form to
 * the review page and stops there. Never submits. Outside author mode it
 * prints only the redacted summary and the redacted report's path.
 */
export async function applyCommand(
  argv: string[],
  over: Partial<ApplyCommandDeps> = {},
): Promise<number> {
  const d: ApplyCommandDeps = { ...defaultDeps(), ...over };
  if (!argv.includes('--dry-run')) {
    d.out(NO_DRY_RUN);
    return 2;
  }
  const url = argv.find((a) => !a.startsWith('--'));
  const jobId = url === undefined ? null : parseJobUrl(url);
  if (jobId === null) {
    d.out(BAD_URL);
    return 2;
  }

  let bank: FactBank;
  try {
    bank = d.loadBank(d.bankPath);
  } catch (e) {
    if (!(e instanceof FactBankError)) throw e;
    d.out(NO_BANK);
    for (const p of e.problems) d.out(`  ${formatProblem(p)}`);
    return 2;
  }
  // The run never goes ahead without the rules.
  let rules: Rules;
  try {
    rules = d.loadRules(d.rulesPath);
  } catch (e) {
    if (!(e instanceof RulesError)) throw e;
    d.out(NO_RULES);
    for (const p of e.problems) d.out(`  ${p}`);
    return 2;
  }
  if (!existsSync(bank.fields.resume)) {
    d.out(NO_RESUME);
    return 2;
  }

  const startedAt = d.now();
  const today = localDate(startedAt);
  const cfg = d.loadConfig();
  const answerCfg = d.loadAnswerConfig();
  const models = {
    answerModel: answerCfg.answerModel,
    verifyModel: answerCfg.verifyModel,
    maxRegenerations: answerCfg.maxRegenerations,
  };
  const profile = d.loadProfile();
  let resume: Resume;
  try {
    resume = d.installResume(bank.fields.resume);
  } catch (e) {
    failed(d, RESUME_FAILED, e);
    return 2;
  }

  const bridge = await d.connect(cfg);
  let run: ApplyRun;
  if ('unavailable' in bridge) {
    d.out(bridge.unavailable);
    run = unavailableRun(jobId, startedAt, bridge.unavailable);
  } else {
    let interrupted = false;
    const offSigint = d.onSigint(() => {
      if (interrupted) d.exit(130);
      interrupted = true;
    });
    try {
      const caller = d.caller();
      const extract = { caller, model: answerCfg.extractModel };
      const raw = new WeakMap<ApplyPage, Page>();
      const stamp = startedAt.toISOString().replaceAll(':', '-');
      let saves = 0;
      run = await d.runApply(jobId, {
        openPage: async () => {
          const page = await bridge.openRunWindow();
          const adapted = adaptApplyPage(page, bridge);
          raw.set(adapted, page);
          return adapted;
        },
        pace: (p) => {
          const page = raw.get(p);
          if (!page) throw new Error('apply: pace for an unknown page');
          return d.createPace(page, profile, {
            viewport: () => bridge.viewport(),
            uploadOnChooser: (file, open, choose) =>
              bridge.uploadOnChooser(file, open, choose),
          });
        },
        stopReason: () =>
          bridge.stopReason() ?? (interrupted ? INTERRUPTED : null),
        // Errors are left to surface as the walker's `error` stop.
        answer: (q, b, job) =>
          answerQuestion(q, { bank: b, job, runDate: today, models, caller }),
        loadBank: () => d.loadBank(d.bankPath),
        saveAnswer: (entry, job) =>
          addKnownAnswer(d.bankPath, entry, {
            company: job.company,
            jobTitle: job.title,
            today,
            stamp: `${stamp}-${++saves}`,
          }),
        io: d.authorMode ? nodeTerminal() : null,
        resume,
        now: () => Date.now(),
        wait: (ms) => sleep(ms),
        // A failed check is the walker's `check-failed` stop; any other
        // error surfaces as its `error` stop.
        checkJob: (job) => extractFromJob(job, extract),
        checkQuestions: (qs, job) => extractFromQuestions(qs, job, extract),
        rules,
      });
    } finally {
      offSigint();
      await bridge.close();
    }
  }

  let paths: { full: string; redacted: string };
  try {
    paths = d.writeReports(run, bank);
  } catch (e) {
    failed(d, REPORTS_FAILED, e);
    return 2;
  }
  if (d.authorMode) {
    d.out(formatRunMarkdown(run, bank).trimEnd());
    d.out(`report: ${paths.redacted}`);
    d.out(`full report: ${paths.full}`);
  } else {
    d.out(formatRedactedSummary(redactApplyRun(run, bank)).trimEnd());
    d.out(`report: ${paths.redacted}`);
  }
  return run.outcome === 'reached-review' ? 0 : 2;
}
