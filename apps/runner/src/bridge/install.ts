import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';

export type Exec = (cmd: string, args: string[]) => string;

/** The Windows folder the extension is installed to, as a WSL path. */
export function windowsExtensionDir(exec: Exec): string {
  const win = exec('cmd.exe', ['/c', 'echo %LOCALAPPDATA%']).trim();
  // An unset variable is echoed back literally.
  if (!/^[A-Za-z]:\\/.test(win)) {
    throw new Error(
      `could not read %LOCALAPPDATA% from Windows (got "${win}")`,
    );
  }
  const local = exec('wslpath', ['-u', win]).trim();
  if (!isAbsolute(local)) {
    throw new Error(`wslpath gave a non-absolute path for "${win}"`);
  }
  return join(local, '10xapply', 'bridge-extension');
}

/** Reuses RUNNER_BRIDGE_TOKEN from envFile, or writes a new one. */
export function ensureToken(envFile: string): string {
  const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  // Same parser as loadConfig, so both sides see the same token.
  const existing = parseEnv(text).RUNNER_BRIDGE_TOKEN;
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(envFile, `${prefix}RUNNER_BRIDGE_TOKEN=${token}\n`, {
    mode: 0o600,
  });
  return token;
}

export function installExtension(o: {
  sourceDir: string;
  targetDir: string;
  port: number;
  token: string;
}): void {
  rmSync(o.targetDir, { recursive: true, force: true });
  mkdirSync(o.targetDir, { recursive: true });
  cpSync(o.sourceDir, o.targetDir, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop() ?? '';
      return !(
        name.endsWith('.spec.js') ||
        name === 'config.example.js' ||
        name === 'config.js'
      );
    },
  });
  writeFileSync(
    join(o.targetDir, 'config.js'),
    `export const RELAY_PORT = ${JSON.stringify(o.port)};\nexport const TOKEN = ${JSON.stringify(o.token)};\n`,
  );
}
