import { pathToFileURL } from 'node:url';
import { botCheckCommand } from './commands/bot-check.js';
import { bridgeCheck, bridgeInstall } from './commands/bridge.js';
import { recordCommand, summaryCommand } from './commands/pace.js';
import { sessionCommand } from './commands/session.js';
import { ConfigError } from './config.js';
import { redact } from './redact.js';
import { RelayPortInUseError } from './relay/relay.js';

const USAGE = `usage: runner <command>
  session          sign in to LinkedIn through the bridge
  bot-check        run the bot-detection check
  bridge install   install the bridge extension
  pace record      record your own timing in Chrome (--typing: also print the typing page URL)
  pace summary     count the recorded samples per measure against the minimums
  bridge check     check the bridge extension (--crash: also check the crash stop)`;

export async function main(argv: string[]): Promise<number> {
  try {
    const [a, b] = argv;
    if (a === 'session') return await sessionCommand();
    if (a === 'bot-check') return await botCheckCommand();
    if (a === 'bridge' && b === 'install') return bridgeInstall();
    if (a === 'bridge' && b === 'check')
      return await bridgeCheck({ crash: argv.includes('--crash') });
    if (a === 'pace' && b === 'record')
      return await recordCommand({ typing: argv.includes('--typing') });
    if (a === 'pace' && b === 'summary') return summaryCommand();
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
