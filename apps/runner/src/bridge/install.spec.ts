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
  windowsExtensionDir,
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

describe('ensureToken', () => {
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
