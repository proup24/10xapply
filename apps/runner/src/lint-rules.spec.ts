import path from 'node:path';
import { ESLint } from 'eslint';

const runnerDir = path.resolve(import.meta.dirname, '..');

async function lint(code: string, filePath = 'src/sample.ts') {
  const eslint = new ESLint({
    cwd: runnerDir,
    overrideConfigFile: path.join(runnerDir, 'eslint.config.mjs'),
  });
  const [result] = await eslint.lintText(code, { filePath });
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

  it.each(['src/commands/x.ts', 'src/pace/x.ts'])(
    'bans page scripts in %s',
    async (file) => {
      const errors = await lint('page.evaluate(() => 1);', file);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("no scripts in LinkedIn's page");
    },
  );

  it('bans input methods outside src/pace', async () => {
    const code = "await page.locator('a').click();";
    const errors = await lint(code, 'src/commands/x.ts');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('pace module');
    expect(await lint(code, 'src/pace/x.ts')).toHaveLength(0);
  });

  it.each([
    'loc.dblclick();',
    "loc.fill('x');",
    "loc.type('x');",
    "loc.press('Enter');",
    "loc.pressSequentially('x');",
    'loc.check();',
    'loc.uncheck();',
    "loc.selectOption('x');",
    "loc.setInputFiles('f');",
    'loc.hover();',
    'loc.tap();',
    'loc.dragTo(other);',
    'page.mouse.move(1, 2);',
    "page.keyboard.down('a');",
    'const m = page.mouse;',
  ])('bans input outside src/pace: %s', async (code) => {
    const errors = await lint(code, 'src/commands/x.ts');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(await lint(code, 'src/pace/x.ts')).toHaveLength(0);
  });

  it('allows locator reads', async () => {
    expect(await lint("await page.locator('a').count();")).toHaveLength(0);
  });
});
