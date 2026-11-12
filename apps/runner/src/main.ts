import { pathToFileURL } from 'node:url';
import { botCheckCommand } from './commands/bot-check.js';
import { bridgeCheck, bridgeInstall } from './commands/bridge.js';
import { practiceCommand } from './pace/practice-run.js';
import {
  buildCommand,
  compareCommand,
  recordCommand,
  summaryCommand,
} from './commands/pace.js';
import { answersEvalCommand } from './commands/answers.js';
import { factsCheckCommand } from './commands/facts.js';
import { sessionCommand } from './commands/session.js';
import { ConfigError } from './config.js';
import { redact } from './redact.js';
import { RelayPortInUseError } from './relay/relay.js';

const USAGE = `usage: runner <command>
  session          sign in to LinkedIn through the bridge
  bot-check        run the bot-detection check (--repeat N: repeat the behaviour pages; --record: record the run)
  bridge install   install the bridge extension
  pace record      record your own timing in Chrome (--typing: also print the typing page URL)
  pace build       build the pace profile from the recordings
  pace practice    run the local practice form with the pace module (--runs N, default 5; --record)
  pace summary     count the recorded samples per measure against the minimums
  pace compare     compare the runner's recordings with yours (shape, timing, variety)
  bridge check     check the bridge extension (--crash: also check the crash stop)
  facts check      check the fact bank file (optional path; prints no values)
  answers eval     run the answerer's golden eval (--set example|private, --answer-model, --verify-model, --judge-model, --repeat N, --case ID)`;

/** The value after `--flag`, as a positive integer, or undefined. */
function intFlag(argv: string[], flag: string): number | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(`${flag} needs a whole number of 1 or more`);
  }
  return n;
}

/** The value after `--flag`, or undefined. */
function stringFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new ConfigError(`${flag} needs a value`);
  }
  return v;
}

/** Flags are `--flag value`. A `--flag=value` form would be silently ignored, so it is refused. */
function refuseEqualsForms(argv: string[]): void {
  const bad = argv.find((a) => a.startsWith('--') && a.includes('='));
  if (bad !== undefined) {
    throw new ConfigError(
      `flags take a space, not "=": write ${bad.split('=')[0]} <value> (see usage)`,
    );
  }
}

function setFlag(argv: string[]): 'example' | 'private' | undefined {
  const v = stringFlag(argv, '--set');
  if (v !== undefined && v !== 'example' && v !== 'private') {
    throw new ConfigError('--set must be example or private');
  }
  return v;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [a, b] = argv;
    if (a === 'session') return await sessionCommand();
    if (a === 'bot-check')
      return await botCheckCommand({
        repeat: intFlag(argv, '--repeat'),
        record: argv.includes('--record'),
      });
    if (a === 'bridge' && b === 'install') return bridgeInstall();
    if (a === 'bridge' && b === 'check')
      return await bridgeCheck({ crash: argv.includes('--crash') });
    if (a === 'pace' && b === 'record')
      return await recordCommand({ typing: argv.includes('--typing') });
    if (a === 'pace' && b === 'build') return buildCommand();
    if (a === 'pace' && b === 'practice')
      return await practiceCommand({
        runs: intFlag(argv, '--runs'),
        record: argv.includes('--record'),
      });
    if (a === 'pace' && b === 'summary') return summaryCommand();
    if (a === 'pace' && b === 'compare') return compareCommand();
    if (a === 'facts' && b === 'check')
      return factsCheckCommand({ path: argv[2] });
    if (a === 'answers' && b === 'eval') {
      refuseEqualsForms(argv);
      return await answersEvalCommand({
        set: setFlag(argv),
        answerModel: stringFlag(argv, '--answer-model'),
        verifyModel: stringFlag(argv, '--verify-model'),
        judgeModel: stringFlag(argv, '--judge-model'),
        repeat: intFlag(argv, '--repeat'),
        caseId: stringFlag(argv, '--case'),
      });
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof RelayPortInUseError) {
      console.error(redact(e.message));
      return 1;
    }
    console.error(redact(e instanceof Error ? e.message : String(e)));
    return 1;
  }
  console.log(USAGE);
  return 64;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
