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
import { join } from 'node:path';

export type Exec = (cmd: string, args: string[]) => string;

/** The Windows folder the extension is installed to, as a WSL path. */
export function windowsExtensionDir(exec: Exec): string {
  const win = exec('cmd.exe', ['/c', 'echo %LOCALAPPDATA%']).trim();
  if (!win) throw new Error('could not read %LOCALAPPDATA% from Windows');
  const local = exec('wslpath', ['-u', win]).trim();
  return join(local, '10xapply', 'bridge-extension');
}

const TOKEN_LINE = /^RUNNER_BRIDGE_TOKEN=(.*)$/m;

/** Reuses RUNNER_BRIDGE_TOKEN from envFile, or writes a new one. */
export function ensureToken(envFile: string): string {
  const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const existing = TOKEN_LINE.exec(text)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
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
