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

  it('isRefused matches the list exactly', () => {
    expect(isRefused('Browser.close')).toBe(true);
    expect(isRefused('Page.enable')).toBe(false);
    expect(isRefused('browser.close')).toBe(false);
  });
});
