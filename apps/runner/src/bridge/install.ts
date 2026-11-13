import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import type { Resume } from '../apply/fill.js';
import { ConfigError } from '../config.js';

export type Exec = (cmd: string, args: string[]) => string;

// cmd.exe warns "UNC paths are not supported" when started from a WSL
// folder, so it runs from the Windows drive instead.
export const realExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    cwd: cmd === 'cmd.exe' ? '/mnt/c' : undefined,
  });

/**
 * The practice form's upload file, beside the extension folder on the
 * Windows side: Chrome reads uploads from its own disk.
 */
export const PRACTICE_FILE = 'practice-resume.pdf';

export function practiceFilePath(extensionDir: string): string {
  return join(dirname(extensionDir), PRACTICE_FILE);
}

/** Copies the practice upload file next to the installed extension. */
export function installPracticeFile(
  source: string,
  extensionDir: string,
): void {
  cpSync(source, practiceFilePath(extensionDir));
}

/** The practice upload file as a Windows path, for the relay-side upload. */
export function windowsPracticeFile(exec: Exec): string {
  const file = practiceFilePath(windowsExtensionDir(exec));
  if (!existsSync(file)) {
    throw new ConfigError(
      `${PRACTICE_FILE} is not on the Windows side; run pnpm nx run runner:bridge-install`,
    );
  }
  return exec('wslpath', ['-w', file]).trim();
}

/**
 * Copies the bank's resume to `resume/<name>` beside the extension folder
 * (Chrome reads uploads from its own disk). The copy is rewritten only when
 * its size or modification time differs, and takes the source's time.
 */
export function installResume(bankResumePath: string, exec: Exec): Resume {
  const fileName = basename(bankResumePath);
  const dir = join(dirname(windowsExtensionDir(exec)), 'resume');
  const target = join(dir, fileName);
  const src = statSync(bankResumePath);
  const old = existsSync(target) ? statSync(target) : null;
  if (
    old === null ||
    old.size !== src.size ||
    Math.abs(old.mtimeMs - src.mtimeMs) >= 1
  ) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(bankResumePath, target);
    const seconds = src.mtimeMs / 1000;
    utimesSync(target, seconds, seconds);
  }
  return {
    fileName,
    windowsPath: exec('wslpath', ['-w', target]).trim(),
  };
}

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
