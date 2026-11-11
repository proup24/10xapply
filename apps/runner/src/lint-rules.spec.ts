import path from 'node:path';
import { ESLint } from 'eslint';

const runnerDir = path.resolve(import.meta.dirname, '..');

async function lint(code: string) {
  const eslint = new ESLint({
    cwd: runnerDir,
    overrideConfigFile: path.join(runnerDir, 'eslint.config.mjs'),
  });
  const [result] = await eslint.lintText(code, { filePath: 'src/sample.ts' });
  return result.messages.filter((m) => m.severity === 2);
}

describe('runner lint rules', () => {
  it.each([
    'page.evaluate(() => 1);',
    'page.evaluateHandle(() => 1);',
    "page.$eval('a', (e) => e);",
    "page.$$eval('a', (e) => e);",
    'loc.evaluateAll((e) => e);',
    "page.exposeFunction('f', () => 1);",
    "page.exposeBinding('f', () => 1);",
    'ctx.addInitScript(() => 1);',
  ])('bans page scripts: %s', async (code) => {
    const errors = await lint(code);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("no scripts in LinkedIn's page");
  });

  it('allows locator reads', async () => {
    expect(await lint("await page.locator('a').count();")).toHaveLength(0);
  });
});
