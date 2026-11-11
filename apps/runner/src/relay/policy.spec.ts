import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REFUSED_METHODS, isRefused } from './policy.js';

const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');

describe('policy', () => {
  it('relay and extension refuse the same methods', async () => {
    const extPolicy = (await import(
      pathToFileURL(
        path.join(workspaceRoot, 'apps/bridge-extension/src/policy.js'),
      ).href
    )) as { REFUSED_METHODS: readonly string[] };
    expect([...REFUSED_METHODS].sort()).toEqual(
      [...extPolicy.REFUSED_METHODS].sort(),
    );
  });

  it('relay and extension isRefused agree on params', async () => {
    const ext = (await import(
      pathToFileURL(
        path.join(workspaceRoot, 'apps/bridge-extension/src/policy.js'),
      ).href
    )) as { isRefused: (method: string, params?: unknown) => boolean };
    const addScript = 'Page.addScriptToEvaluateOnNewDocument';
    const cases: [string, unknown, boolean][] = [
      [addScript, { source: '', worldName: 'utility' }, false],
      [addScript, { source: 'alert(1)' }, true],
      [addScript, { source: ' ' }, true],
      [addScript, {}, true],
      [addScript, { source: 0 }, true],
      [addScript, undefined, true],
      [addScript, null, true],
      ['Browser.close', {}, true],
      ['Network.getAllCookies', { source: '' }, true],
      ['Page.enable', {}, false],
      ['browser.close', undefined, false],
    ];
    for (const [method, params, refused] of cases) {
      expect([method, params, isRefused(method, params)]).toEqual([
        method,
        params,
        refused,
      ]);
      expect([method, params, ext.isRefused(method, params)]).toEqual([
        method,
        params,
        refused,
      ]);
    }
    expect(REFUSED_METHODS).toContain(addScript);
  });
});
