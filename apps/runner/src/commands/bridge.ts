import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBridge } from '../bridge/bridge.js';
import {
  ensureToken,
  installExtension,
  windowsExtensionDir,
  type Exec,
} from '../bridge/install.js';
import { ENV_FILE, loadConfig, resolveRelayPort } from '../config.js';

const realExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8' });

/** apps/bridge-extension/src, resolved from this file, not the cwd. */
const SOURCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'bridge-extension',
  'src',
);

export function bridgeInstall(exec: Exec = realExec): number {
  const token = ensureToken(ENV_FILE);
  const port = resolveRelayPort();
  const targetDir = windowsExtensionDir(exec);
  installExtension({ sourceDir: SOURCE_DIR, targetDir, port, token });
  const winPath = exec('wslpath', ['-w', targetDir]).trim();
  console.log(`bridge extension installed to ${winPath}
Next, in Chrome:
  1. Open chrome://extensions and turn on Developer mode.
  2. Click "Load unpacked".
  3. Choose ${winPath}`);
  return 0;
}

export async function bridgeCheck(): Promise<number> {
  const cfg = loadConfig();
  const bridge = await connectBridge(cfg);
  if ('unavailable' in bridge) {
    console.log(bridge.unavailable);
    return 2;
  }
  try {
    const page = await bridge.openRunWindow();
    await page.goto('about:blank');
    await page.close();
    console.log('bridge: connected');
    return 0;
  } finally {
    await bridge.close();
  }
}
