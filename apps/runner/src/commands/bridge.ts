import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBridge, type Bridge } from '../bridge/bridge.js';
import {
  ensureToken,
  installExtension,
  windowsExtensionDir,
  type Exec,
} from '../bridge/install.js';
import { ENV_FILE, loadConfig, resolveRelayPort } from '../config.js';

// cmd.exe warns "UNC paths are not supported" when started from a WSL
// folder, so it runs from the Windows drive instead.
const realExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    cwd: cmd === 'cmd.exe' ? '/mnt/c' : undefined,
  });

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
  3. Choose ${winPath}
On a re-install, skip those steps: click Reload on "10xapply bridge" in
chrome://extensions so Chrome picks up the new files.`);
  return 0;
}

export async function bridgeCheck({
  crash = false,
}: { crash?: boolean } = {}): Promise<number> {
  const cfg = loadConfig();
  const bridge = await connectBridge(cfg);
  if ('unavailable' in bridge) {
    console.log(bridge.unavailable);
    return 2;
  }
  try {
    const page = await bridge.openRunWindow();
    await page.goto('about:blank');
    if (crash) return await crashCheck(bridge);
    await page.close();
    console.log('bridge: connected');
    return 0;
  } finally {
    await bridge.close();
  }
}

const CRASH_WAIT_MS = 5000;

// Crashes the run tab on purpose and checks the bridge notices the stop.
async function crashCheck(bridge: Bridge): Promise<number> {
  // Not page.context().newCDPSession(): Patchright's needs
  // Target.attachToBrowserTarget, which the relay refuses.
  await bridge.crashRunTab().catch(() => undefined);
  const deadline = Date.now() + CRASH_WAIT_MS;
  while (bridge.stopReason() === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const reason = bridge.stopReason();
  if (reason === null) {
    console.log('crash stop: not seen');
    return 2;
  }
  console.log(`crash stop: ok (${reason})`);
  return 0;
}
