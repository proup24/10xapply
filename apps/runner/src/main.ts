import { pathToFileURL } from 'node:url';
import { bridgeCheck, bridgeInstall } from './commands/bridge.js';
import { sessionCommand } from './commands/session.js';
import { ConfigError } from './config.js';
import { RelayPortInUseError } from './relay/relay.js';

const USAGE = `usage: runner <command>
  session          sign in to LinkedIn through the bridge
  bot-check        run the bot-detection check
  bridge install   install the bridge extension
  bridge check     check the bridge extension`;

export async function main(argv: string[]): Promise<number> {
  try {
    const [a, b] = argv;
    if (a === 'session') return await sessionCommand();
    if (a === 'bridge' && b === 'install') return bridgeInstall();
    if (a === 'bridge' && b === 'check') return await bridgeCheck();
  } catch (e) {
    if (e instanceof ConfigError || e instanceof RelayPortInUseError) {
      console.error(e.message);
      return 1;
    }
    console.error(e instanceof Error ? e.message : String(e));
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
