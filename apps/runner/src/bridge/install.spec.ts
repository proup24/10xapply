import { loadConfig } from '../config.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureToken,
  installExtension,
  installPracticeFile,
  PRACTICE_FILE,
  windowsExtensionDir,
  windowsPracticeFile,
} from './install.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'inst-'));

describe('windowsExtensionDir', () => {
  it('maps %LOCALAPPDATA% to a WSL path', () => {
    const calls: string[][] = [];
    const answers = [
      'C:\\Users\\u\\AppData\\Local\r\n',
      '/mnt/c/Users/u/AppData/Local\n',
    ];
    const dir = windowsExtensionDir((cmd, args) => {
      calls.push([cmd, ...args]);
      return answers.shift() ?? '';
    });
    expect(dir).toBe('/mnt/c/Users/u/AppData/Local/10xapply/bridge-extension');
    expect(calls[0]).toEqual(['cmd.exe', '/c', 'echo %LOCALAPPDATA%']);
    expect(calls[1]).toEqual(['wslpath', '-u', 'C:\\Users\\u\\AppData\\Local']);
  });
});

describe('windowsExtensionDir failures', () => {
  it('rejects an unexpanded %LOCALAPPDATA%', () => {
    expect(() => windowsExtensionDir(() => '%LOCALAPPDATA%\r\n')).toThrow(
      /LOCALAPPDATA/,
    );
  });
  it('rejects a relative wslpath result', () => {
    const answers = ['C:\\Users\\u\n', 'Users/u\n'];
    expect(() => windowsExtensionDir(() => answers.shift() ?? '')).toThrow(
      /non-absolute/,
    );
  });
});

describe('ensureToken', () => {
  it('reads a quoted value with a trailing comment like loadConfig', () => {
    const file = join(tmp(), 'runner-env-test');
    writeFileSync(file, 'RUNNER_BRIDGE_TOKEN="abc" # note\n');
    expect(ensureToken(file)).toBe('abc');
    expect(loadConfig({}, file).token).toBe('abc');
  });

  it('is stable, long enough, and keeps other keys', () => {
    const file = join(tmp(), 'runner-env-test');
    writeFileSync(file, 'OTHER=1');
    const a = ensureToken(file);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(ensureToken(file)).toBe(a);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('OTHER=1\n');
    expect(text.match(/RUNNER_BRIDGE_TOKEN=/g)).toHaveLength(1);
  });

  it('creates the file when missing', () => {
    const file = join(tmp(), 'runner-env-test');
    expect(ensureToken(file)).toHaveLength(43);
  });
});

describe('installExtension', () => {
  it('copies the extension, writes config.js, drops specs and stale files', () => {
    const src = tmp();
    for (const f of [
      'manifest.json',
      'background.js',
      'bridge-core.js',
      'policy.js',
      'bridge-core.spec.js',
      'config.example.js',
      'config.js',
    ])
      writeFileSync(join(src, f), f === 'config.js' ? 'LOCAL' : 'x');
    const target = tmp();
    writeFileSync(join(target, 'stale.js'), 'old');
    mkdirSync(join(target, 'old-dir'));

    installExtension({
      sourceDir: src,
      targetDir: target,
      port: 9444,
      token: 'tok',
    });

    for (const f of [
      'manifest.json',
      'background.js',
      'bridge-core.js',
      'policy.js',
    ])
      expect(existsSync(join(target, f))).toBe(true);
    for (const f of [
      'bridge-core.spec.js',
      'config.example.js',
      'stale.js',
      'old-dir',
    ])
      expect(existsSync(join(target, f))).toBe(false);
    const cfg = readFileSync(join(target, 'config.js'), 'utf8');
    expect(cfg).toContain('RELAY_PORT = 9444');
    expect(cfg).toContain('TOKEN = "tok"');
  });
});

describe('the practice upload file', () => {
  it('is copied beside the extension folder, outside the extension', () => {
    const root = tmp();
    const ext = join(root, 'bridge-extension');
    mkdirSync(ext);
    const src = join(tmp(), 'resume.pdf');
    writeFileSync(src, '%');
    installPracticeFile(src, ext);
    expect(readFileSync(join(root, PRACTICE_FILE), 'utf8')).toBe('%');
    expect(existsSync(join(ext, PRACTICE_FILE))).toBe(false);
  });

  it('is given to Chrome as a Windows path', () => {
    const root = tmp();
    mkdirSync(join(root, '10xapply'));
    writeFileSync(join(root, '10xapply', PRACTICE_FILE), '%');
    const calls: string[][] = [];
    const answers = ['C:\\L\r\n', `${root}\n`, 'C:\\L\\10xapply\\x.pdf\n'];
    const path = windowsPracticeFile((cmd, args) => {
      calls.push([cmd, ...args]);
      return answers.shift() ?? '';
    });
    expect(path).toBe('C:\\L\\10xapply\\x.pdf');
    expect(calls[2]).toEqual([
      'wslpath',
      '-w',
      join(root, '10xapply', PRACTICE_FILE),
    ]);
  });

  it('asks for bridge install when the file is missing', () => {
    const root = tmp();
    const answers = ['C:\\L\r\n', `${root}\n`];
    expect(() => windowsPracticeFile(() => answers.shift() ?? '')).toThrow(
      /bridge-install/,
    );
  });
});
