# Local Browser and the LinkedIn Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runner reaches the author's everyday Windows Chrome through our own bridge extension and a token-protected relay, drives it with Patchright, and reports whether the LinkedIn session is signed in, without touching cookies or running scripts in LinkedIn's page.

**Architecture:** Two new Nx projects:

- `apps/bridge-extension`: a plain-JS MV3 extension. It attaches `chrome.debugger` only to windows it opens itself.
- `apps/runner`: a Node CLI. It starts a WebSocket relay on `127.0.0.1`, which looks like a whole browser's CDP endpoint to `patchright-core` and forwards to the extension. It also has the `bridge install`, `bridge check`, `bot-check` and `session` commands.

Both the relay and the extension refuse cookie, close and script-planting CDP methods. Session classification is pure code, tested on fixtures.

**Tech Stack:** Nx 24.0.2, pnpm 12, Node 24, TypeScript (nodenext, strict), Vitest 5, `patchright-core` 1.64.3 (exact), `ws` 8, `tsx` 4, `linkedom` (tests only), Chrome MV3.

**Spec:** `docs/superpowers/specs/2026-11-11-local-browser-and-session-design.md`

## Global Constraints

- Branch `feat/local-browser-and-session` (it already holds the spec commit). Never work on `main`.
- `patchright-core` pinned to exactly `1.64.3`, with no `^`. No `playwright` or `playwright-core` dependency anywhere.
- The relay listens on `127.0.0.1` only. Default port `9333`, which `RUNNER_RELAY_PORT` overrides.
- Never `page.evaluate`, `evaluateHandle`, `$eval`, `$$eval`, `evaluateAll`, `exposeFunction`, `exposeBinding` or `addInitScript`. Read pages only through `locator(...).count()`, `inputValue()`, `innerText()`, `page.url()` and `page.title()`.
- No runner code reads, logs or stores a cookie, page text from LinkedIn, or a full LinkedIn URL path. Logs carry CDP method names only.
- Extension manifest: MV3, permissions exactly `["debugger", "tabs", "alarms"]`. No `host_permissions`, `content_scripts`, `web_accessible_resources` or `key`.
  - `alarms` is an addition the spec didn't list. MV3 needs it for the 30-second reconnect timer the spec requires, and web pages can't see it.
- Run reports go only to the repo-root `run-reports/` (git-ignored). Raw page saves go only to `run-reports/raw-pages/`.
- Claude may run `bridge install`, `bridge check` and `bot-check` freely. Claude runs `session` only when the author asks in that session.
- Commands use `pnpm` (`pnpm nx …`). Prettier runs on edited files automatically.

## Review Focus

1. **The debugger detaches mid-run** (the author clicks in the run window or closes it, or hits Cancel on the yellow bar): the result is `stopped`, nothing is retried, and closing the page doesn't throw. Tested in Task 6 (`runSession` "stopped mid-load").
2. **The extension never connects** (Chrome closed, extension not loaded, or WSL mirrored networking off): within 45 s the result is `bridge-unavailable`, and the message names those three causes. Tested in Task 4 (`waitForExtension` timeout) and Task 5 (`connectBridge` unavailable).
3. **`bridge install` never run** (no token): every command except `bridge install` exits non-zero with "run `pnpm nx run runner:bridge-install` first", before starting a relay. Tested in Task 5 (`loadConfig`).
4. **Port 9333 already in use** (a second runner, or the spike relay still running): a clear "relay port 9333 is in use; is another runner running?" error and exit code 1, not a stack trace. Tested in Task 4.
5. **LinkedIn redirects to a path carrying the author's identity** (for example `/in/<handle>/`): only the first path segment (`/in/`) reaches the report. Tested in Task 6 (`pathPrefix`).

---

### Task 1: Scaffold the runner and extension projects, with the no-page-scripts lint rule

**Files:**

- Modify: `pnpm-workspace.yaml` (add `apps/*`), `tsconfig.json` (references)
- Create: `apps/runner/package.json`, `apps/runner/tsconfig.json`, `apps/runner/tsconfig.app.json`, `apps/runner/tsconfig.spec.json`, `apps/runner/vitest.config.mts`, `apps/runner/eslint.config.mjs`, `apps/runner/src/main.ts`
- Create: `apps/bridge-extension/package.json`, `apps/bridge-extension/vitest.config.mts`, `apps/bridge-extension/eslint.config.mjs`
- Test: `apps/runner/src/lint-rules.spec.ts`

**Interfaces:**

- Produces:
  - Nx projects `runner` (package `@xapply/runner`) and `bridge-extension` (package `@xapply/bridge-extension`).
  - `apps/runner/src/main.ts` exports `main(argv: string[]): Promise<number>`. For now it prints usage and returns 64.
  - Nx targets on `runner`, all `nx:run-commands` with `cwd: apps/runner` and command `tsx src/main.ts <words>`:

    | Nx target        | Command words    |
    | ---------------- | ---------------- |
    | `session`        | `session`        |
    | `bot-check`      | `bot-check`      |
    | `bridge-install` | `bridge install` |
    | `bridge-check`   | `bridge check`   |

- [ ] **Step 1: Scaffold.**
  - Copy the tsconfig, vitest and eslint shape from `/home/lab/apps/10xjobs/apps/xjobs`, minus Nest and decorators.
  - `@xapply/runner` dependencies: `patchright-core@1.64.3`, `ws@^8.22.2`. Dev dependencies: `@types/ws`, `tsx@^4.23.15`, `linkedom@^0.18.15`.
  - `@xapply/bridge-extension` has no dependencies. Its source is plain ES-module JS under `src/`, and its vitest uses environment `node`.
  - Run `pnpm install`. If `patchright-core` asks for a build approval, leave it disallowed in `allowBuilds`, since the core package downloads no browser.
- [ ] **Step 2: Write the failing lint test.** In `lint-rules.spec.ts`, use ESLint's `ESLint` class with `cwd` at the workspace root and `lintText(code, { filePath: 'apps/runner/src/sample.ts' })`.
  - Test `bans page scripts`: each of `page.evaluate(() => 1)`, `page.evaluateHandle(() => 1)`, `page.$eval('a', (e) => e)`, `page.$$eval('a', (e) => e)`, `loc.evaluateAll((e) => e)`, `page.exposeFunction('f', () => 1)`, `page.exposeBinding('f', () => 1)` and `ctx.addInitScript(() => 1)` yields one error whose message contains `no scripts in LinkedIn's page`.
  - Test `allows locator reads`: `await page.locator('a').count()` yields no error.
- [ ] **Step 3: Run it.** `pnpm nx test runner`. Expected: FAIL (`bans page scripts`).
- [ ] **Step 4: Add the rule.** In `apps/runner/eslint.config.mjs`, add `no-restricted-syntax` with the selector `MemberExpression[property.name=/^(evaluate|evaluateHandle|\$eval|\$\$eval|evaluateAll|exposeFunction|exposeBinding|addInitScript)$/]` and the message `no scripts in LinkedIn's page (spec 2026-11-11): use locators`.
- [ ] **Step 5: Verify.** `pnpm nx test runner`, then `pnpm nx run-many -t lint test typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(runner): scaffold runner and bridge-extension projects`.

### Task 2: Guard knows the runner

**Files:**

- Modify: `.claude/hooks/guard.mjs:340-341`
- Test: `.claude/hooks/guard.test.mjs`

**Interfaces:**

- Produces:
  - `RUNNER_NAME = 'runner'`.
  - `RUNNER_SAFE_SUBCOMMANDS = ['bridge', 'bridge-install', 'bridge-check', 'bot-check', 'session']`. The Nx target names are listed as well as the CLI words, because the guard reads an Nx target as the subcommand.

- [ ] **Step 1: Write the failing tests.** They use the defaults, so no `opts` is passed.
  - `runner (real name): non-dry launches blocked`: each of these is blocked:
    - `pnpm nx run runner:apply`
    - `cd apps/runner && pnpm exec tsx src/main.ts apply x`
    - `tsx apps/runner/src/main.ts apply x`
    - `node apps/runner/src/main.ts apply x`
  - `runner (real name): safe commands pass`: each of these passes:
    - `pnpm nx run runner:session`, `pnpm nx run runner:bot-check`, `pnpm nx run runner:bridge-install`, `pnpm nx run runner:bridge-check`
    - `tsx apps/runner/src/main.ts bridge check`
    - `pnpm nx run runner:apply --dry-run`
  - `runner (real name): no false positives`: each of these passes:
    - `ls apps/runner`, `cat apps/runner/src/main.ts`, `pnpm nx test runner`, `pnpm nx lint runner`
    - `pnpm nx run-many -t lint test build typecheck`, `pnpm nx affected -t test`
    - `grep -rn runner docs`, `echo "test runner"`, `git commit -m "runner: add relay"`
    - `pnpm vitest run --reporter verbose`
- [ ] **Step 2: Run it.** `pnpm test:hooks`. Expected: FAIL.
- [ ] **Step 3: Set the two constants.** If any no-false-positive case fails and the fix isn't a small, clearly correct guard change, stop and rename the project to a more distinctive name (for example `li-runner`) across Tasks 1–2 instead. Say so in the PR, as the spec requires.
- [ ] **Step 4: Verify.** `pnpm test:hooks`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(guard): name the runner and its safe commands`.

### Task 3: Bridge extension

**Files:**

- Create: `apps/bridge-extension/src/manifest.json`, `src/policy.js`, `src/bridge-core.js`, `src/background.js`, `src/config.example.js`
- Test: `apps/bridge-extension/src/bridge-core.spec.js`, `src/manifest.spec.js`

**Interfaces:**

- Produces the wire protocol (JSON over one WebSocket), which Task 4 implements on the other side:
  - **Connection.** The extension connects to `ws://127.0.0.1:<port>/extension?token=<token>`.
  - **Relay → extension commands:** `{ id, method, params }`. The extension answers with `{ id, result }` or `{ id, error: string }`.
    - `run.createWindow`, params `{ url }`, returns `{ tabId, windowId }`. Uses `chrome.windows.create({ url, focused: true, state: 'normal' })`.
    - `tabs.remove`, params `{ tabId }`, returns `{}`.
    - `debugger.attach`, params `{ tabId }`, returns `{}`. Protocol `'1.3'`.
    - `debugger.send`, params `{ target: { tabId, sessionId? }, method, params }`, returns the CDP result.
  - **Extension → relay events:** `{ method, params }`.
    - `debugger.event`, params `{ source, method, params }`.
    - `debugger.detach`, params `{ tabId, reason }`.
    - `tabs.removed`, params `{ tabId }`.
    - `window.state`, params `{ tabId, windowId, state }`, sent on every `chrome.windows.onBoundsChanged` for a run window and whenever its state is `minimized`.
    - `ping`, params `{}`, sent every 20 s while connected.
- Also produces:
  - `policy.js`: `export const REFUSED_METHODS` (a frozen array of strings) and `export function isRefused(method)`. The list:
    - `Network.getCookies`, `Network.getAllCookies`, `Network.setCookie`, `Network.setCookies`, `Network.deleteCookies`, `Network.clearBrowserCookies`
    - `Storage.getCookies`, `Storage.setCookies`, `Storage.clearCookies`, `Storage.clearDataForOrigin`
    - `DOMStorage.getDOMStorageItems`, `Page.getCookies`
    - `Browser.close`, `Browser.crash`, `Target.exposeDevToolsProtocol`
    - `Runtime.addBinding`, `Page.addScriptToEvaluateOnNewDocument`
  - `bridge-core.js`: `export function createBridgeCore(chromeApi, send)`, which returns `{ handleCommand(msg): Promise<void>, ownsTab(tabId): boolean, onDebuggerEvent, onDebuggerDetach, onTabRemoved, onWindowChanged }`. The `on…` handlers are wired to `chrome.*` listeners by `background.js`. `chromeApi` is the subset `{ windows, tabs, debugger }`, so tests pass a fake.

- [ ] **Step 1: Write the failing tests** in `bridge-core.spec.js`, with a fake `chromeApi` that records calls:
  - `run.createWindow opens a focused normal window and owns its tab`: `windows.create` is called with `{ url: 'about:blank', focused: true, state: 'normal' }`, the reply carries `tabId`, and `ownsTab` is true.
  - `refuses tabs it did not create`: `debugger.attach`, `debugger.send` and `tabs.remove` with an unknown `tabId` reply `{ error: 'not a bridge tab' }`, and the fake records no chrome call.
  - `refuses policy methods`: `debugger.send` with `Network.getAllCookies`, `Browser.close` and `Runtime.addBinding` on an owned tab reply `{ error: 'refused: <method>' }`, and the fake records no `debugger.sendCommand`.
  - `forwards events only for own tabs`: an `onDebuggerEvent` for a foreign tab sends nothing. For an owned tab it sends `debugger.event`.
  - `reports detach reason`: `onDebuggerDetach({ tabId }, 'canceled_by_user')` sends `debugger.detach` with `reason: 'canceled_by_user'`.
  - `reports minimised run window`: `onWindowChanged` with state `minimized` for the run window sends `window.state` with `state: 'minimized'`.
- [ ] **Step 2: Write the failing tests** in `manifest.spec.js`: `manifest exposes nothing to pages` asserts the manifest has `manifest_version` 3, permissions deep-equal `['debugger', 'tabs', 'alarms']`, and no `host_permissions`, `content_scripts`, `web_accessible_resources` or `key`.
- [ ] **Step 3: Run them.** `pnpm nx test bridge-extension`. Expected: FAIL.
- [ ] **Step 4: Implement** `policy.js`, `bridge-core.js` and `manifest.json` (background `{ service_worker: 'background.js', type: 'module' }`). Then write `background.js`:
  - It imports `{ RELAY_PORT, TOKEN }` from `./config.js`.
  - It connects on `chrome.runtime.onStartup`, on `onInstalled`, and on a `chrome.alarms` alarm named `reconnect` with `periodInMinutes: 0.5`.
  - It sends `ping` every 20 s while open.
  - The badge text is `on` or empty.
  - `config.example.js` shows the two exports. `config.js` itself is written only into the installed copy (Task 5).
- [ ] **Step 5: Verify.** `pnpm nx test bridge-extension` and `pnpm nx lint bridge-extension`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(bridge-extension): own-window-only CDP bridge`.

### Task 4: Relay

**Files:**

- Create: `apps/runner/src/relay/policy.ts`, `apps/runner/src/relay/relay.ts`
- Test: `apps/runner/src/relay/relay.spec.ts`, `apps/runner/src/relay/policy.spec.ts`

**Interfaces:**

- Consumes: the wire protocol from Task 3.
- Produces:

  ```ts
  // policy.ts
  export const REFUSED_METHODS: readonly string[];
  export function isRefused(method: string): boolean;

  // relay.ts
  export type BridgeEvent =
    | { kind: 'detached'; tabId: number; reason: string }
    | { kind: 'window-minimized'; tabId: number }
    | { kind: 'extension-disconnected' };
  export interface RelayOptions {
    port: number;
    token: string;
    log?: (line: string) => void;
  }
  export interface Relay {
    cdpUrl: string; // ws://127.0.0.1:<port>/cdp?token=<token>
    waitForExtension(timeoutMs: number): Promise<boolean>;
    onEvent(fn: (e: BridgeEvent) => void): () => void;
    stop(): Promise<void>;
  }
  export class RelayPortInUseError extends Error {}
  export function startRelay(opts: RelayOptions): Promise<Relay>;
  ```

- Behaviour:
  - Port Playwright's `CDPRelayServer`/`BrowserModel` (`playwright-core` 1.65, `tools/mcp/cdpRelay*.ts`, `browserModel.ts`), mapping its `chrome.*` calls onto Task 3's names.
  - It answers `Browser.getVersion` and `Browser.setDownloadBehavior` locally.
  - `Target.setAutoAttach` on the root session attaches nothing pre-existing, because the extension owns only its own windows.
  - `Target.createTarget` becomes `run.createWindow` then `debugger.attach`. `Target.closeTarget` becomes `tabs.remove`.
  - Root-level commands that arrive while no tab is attached reply `{}`.
  - Refused methods reply with a CDP error `refused: <method>` and are never sent on.
  - A bad or missing token closes the socket with code `4401`. A second client of either kind closes with `4409`.
  - `log` receives `<- <method>` or `-> <method>` only.

- [ ] **Step 1: Write the failing tests** in `relay.spec.ts`. They start the relay on port 0 or a random free port, with a fake extension as a `ws` client that answers commands and a fake CDP client as a `ws` client:
  - `rejects bad token`: both endpoints close with code 4401 when the token is wrong or missing.
  - `rejects second client`: a second extension and a second CDP client each close with code 4409.
  - `createTarget opens a run window and announces it`: the CDP `Target.createTarget` makes the fake extension receive `run.createWindow`, then `debugger.attach`. The CDP client gets a `Target.attachedToTarget` with a session id and the targetId from `Target.getTargetInfo`.
  - `routes session commands to the right tab`: `Page.enable` on that session reaches the fake extension as `debugger.send` with `target.tabId` equal to that tab.
  - `refuses policy methods`: `Network.getAllCookies`, `Storage.getCookies`, `Browser.close` and `Page.addScriptToEvaluateOnNewDocument` get a CDP error whose message starts with `refused:`, and the fake extension receives nothing.
  - `emits bridge events`: `debugger.detach`, then `window.state` minimised, then the extension socket closing, produce `detached` (with its reason), `window-minimized` and `extension-disconnected`, in that order. The CDP client also gets `Target.detachedFromTarget`.
  - `logs method names only`: after a `Runtime.evaluate` with `params.expression: 'SECRET'`, no logged line contains `SECRET`.
  - `waitForExtension times out`: it resolves `false` after the timeout (use 50 ms) when nothing connects, and `true` as soon as one does.
  - `port in use`: starting a second relay on the same port rejects with `RelayPortInUseError`, with message `relay port <port> is in use; is another runner running?`.
- [ ] **Step 2: Write the failing test** in `policy.spec.ts`: `relay and extension refuse the same methods`. Import `apps/bridge-extension/src/policy.js` through `pathToFileURL` on a path resolved from the workspace root, then assert `REFUSED_METHODS` deep-equals the extension's list, as sorted copies.
- [ ] **Step 3: Run them.** `pnpm nx test runner`. Expected: FAIL.
- [ ] **Step 4: Implement** `policy.ts` and `relay.ts` to the interface above.
- [ ] **Step 5: Verify.** `pnpm nx test runner`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(runner): token-protected CDP relay`.

### Task 5: Config, bridge install, bridge connection and `bridge check`

**Files:**

- Create: `apps/runner/src/config.ts`, `apps/runner/src/bridge/install.ts`, `apps/runner/src/bridge/bridge.ts`, `apps/runner/src/commands/bridge.ts`
- Modify: `apps/runner/src/main.ts`
- Test: `apps/runner/src/config.spec.ts`, `apps/runner/src/bridge/install.spec.ts`, `apps/runner/src/bridge/bridge.spec.ts`

**Interfaces:**

- Consumes: `startRelay`, `Relay` and `BridgeEvent` from Task 4.
- Produces:

  ```ts
  // config.ts
  export const ENV_FILE: string; // absolute path of apps/runner/.env.local
  export interface RunnerConfig {
    relayPort: number;
    token: string;
  }
  export class ConfigError extends Error {}
  export function loadConfig(
    env?: NodeJS.ProcessEnv,
    envFile?: string,
  ): RunnerConfig;
  // Reads envFile with process.loadEnvFile if it exists. Keys: RUNNER_BRIDGE_TOKEN,
  // RUNNER_RELAY_PORT (default 9333). Missing token → ConfigError
  // "no bridge token: run `pnpm nx run runner:bridge-install` first".

  // bridge/install.ts
  export type Exec = (cmd: string, args: string[]) => string;
  export function windowsExtensionDir(exec: Exec): string;
  // `cmd.exe /c echo %LOCALAPPDATA%` → `wslpath -u` → join '10xapply/bridge-extension'.
  export function ensureToken(envFile: string): string;
  // Reuses RUNNER_BRIDGE_TOKEN if present, else writes randomBytes(32) base64url.
  export function installExtension(o: {
    sourceDir: string;
    targetDir: string;
    port: number;
    token: string;
  }): void;
  // Replaces targetDir with sourceDir's files, minus *.spec.js and
  // config.example.js, then writes config.js.

  // bridge/bridge.ts
  export interface Bridge {
    openRunWindow(): Promise<import('patchright-core').Page>;
    stopReason(): string | null; // set by detached / window-minimized / extension-disconnected
    close(): Promise<void>; // disconnects Patchright without Browser.close, stops the relay
  }
  export const EXTENSION_TIMEOUT_MS = 45_000;
  export function connectBridge(
    cfg: RunnerConfig,
    deps?: {
      connectOverCDP?: typeof import('patchright-core').chromium.connectOverCDP;
    },
  ): Promise<Bridge | { unavailable: string }>;
  // Unavailable message:
  // "the bridge extension did not connect within 45 s: is Chrome open, is the
  // extension loaded, and is WSL networking mirrored?"
  ```

- CLI:
  - `bridge install` runs `ensureToken(ENV_FILE)`, `installExtension` and prints the three author steps (developer mode, Load unpacked, the Windows path in `C:\…` form from `wslpath -w`).
  - `bridge check` runs `connectBridge`, `openRunWindow`, `goto('about:blank')`, then closes the page. It prints `bridge: connected` with exit code 0, or the unavailable message with exit code 2.
  - A `ConfigError` or `RelayPortInUseError` prints its message and exits 1.

- [ ] **Step 1: Write the failing tests.**
  - `loadConfig`: reads token and port from a temp env file; the port defaults to 9333; a missing token throws `ConfigError` with the message above.
  - `windowsExtensionDir`: when the fake `exec` returns `C:\Users\u\AppData\Local\r\n` and then `/mnt/c/Users/u/AppData/Local`, it returns `/mnt/c/Users/u/AppData/Local/10xapply/bridge-extension`.
  - `ensureToken`: the same token comes back on a second call, it is at least 43 characters, and the file keeps any other keys.
  - `installExtension`: the target has `manifest.json`, `background.js`, `bridge-core.js`, `policy.js` and `config.js` with the port and token, and no `*.spec.js` or `config.example.js`. A stale file from a previous install is gone.
  - `connectBridge`: with a fake extension that never connects and a 50 ms timeout override, it returns `{ unavailable }` with the message above. With a fake extension plus a fake `connectOverCDP`, it returns a `Bridge`, and after the fake sends `debugger.detach` with reason `canceled_by_user`, `stopReason()` returns `debugger detached: canceled_by_user`. In a fresh bridge, a `window.state` event with `state: 'minimized'` makes `stopReason()` return `run window minimized`.
- [ ] **Step 2: Run them.** `pnpm nx test runner`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above to those interfaces, and wire `main.ts` dispatch for `bridge install` and `bridge check`.
- [ ] **Step 4: Verify.** `pnpm nx test runner`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(runner): bridge install and bridge check`.

### Task 6: Session classification, run reports and `runner session`

**Files:**

- Create: `apps/runner/src/session/classify.ts`, `apps/runner/src/session/session.ts`, `apps/runner/src/reports/write-report.ts`, `apps/runner/src/commands/session.ts`
- Create: `apps/runner/src/session/fixtures/signed-in-feed.html` (hand-made), `checkpoint-challenge.html` (hand-made), `README.md` (one line per fixture: where it came from, and that it was scrubbed)
- Modify: `apps/runner/src/main.ts`
- Test: `apps/runner/src/session/classify.spec.ts`, `apps/runner/src/session/session.spec.ts`, `apps/runner/src/reports/write-report.spec.ts`

**Interfaces:**

- Consumes: `connectBridge` and `Bridge` (Task 5).
- Produces:

  ```ts
  // classify.ts
  export type PageResult =
    'signed-in' | 'signed-out' | 'security-check' | 'unexpected-page';
  export type SessionResult = PageResult | 'stopped' | 'bridge-unavailable';
  export const SIGN_IN_FORM = 'input#username, input[name="session_key"]';
  export const CHALLENGE =
    'iframe[src*="captcha"], #captcha-internal, form[action*="checkpoint"]';
  export interface PageSignals {
    path: string;
    signInForms: number;
    challenges: number;
  }
  export function classifySession(s: PageSignals): PageResult;
  // Order: path starts with /checkpoint/ or challenges > 0 → security-check;
  // path starts with /login, /uas/login, /authwall, or signInForms > 0 → signed-out;
  // path starts with /feed → signed-in; else unexpected-page.

  // reports/write-report.ts
  export const REPORTS_DIR: string; // <workspace>/run-reports
  export function pathPrefix(path: string): string; // '/in/abc/' → '/in/', '/' → '/'
  export interface SessionReport {
    kind: 'session';
    startedAt: string; // ISO
    result: SessionResult;
    pathPrefix: string | null;
    stopReason?: string;
    timings: { loadMs: number; totalMs: number };
  }
  export function writeRunReport(r: SessionReport, dir?: string): string;
  // File `session-<startedAt with ':' → '-'>.json`; creates dir; returns path.

  // session/session.ts
  export const FEED_URL = 'https://www.linkedin.com/feed/';
  export interface SessionPage {
    goto(url: string): Promise<void>; // domcontentloaded, 30 s timeout
    path(): string;
    count(selector: string): Promise<number>;
    close(): Promise<void>;
  }
  export interface SessionDeps {
    openPage(): Promise<SessionPage>;
    stopReason(): string | null;
    wait(ms: number): Promise<void>;
    randomInt(min: number, max: number): number; // crypto.randomInt in production
    now(): number;
  }
  export function runSession(d: SessionDeps): Promise<SessionReport>;
  // goto FEED_URL → wait randomInt(4000, 8000) → stopReason? → stopped
  // → signals → classify → wait randomInt(1500, 4000) → close (errors swallowed).
  // goto throwing: stopReason set → stopped, else unexpected-page. No retry, no reload.
  ```

- CLI: `session` uses `loadConfig` and `connectBridge`. If the bridge is unavailable, the report result is `bridge-unavailable`. It always writes the report, prints `session: <result>` and the report path, and exits 0 only for `signed-in`, otherwise 2.

- [ ] **Step 1: Write the failing tests.**
  - `classify.spec.ts`, as a table on `classifySession`:
    - `/feed/foryou/` with 0 and 0 gives signed-in;
    - `/feed/` with a sign-in form gives signed-out;
    - `/login` gives signed-out;
    - `/uas/login` gives signed-out;
    - `/authwall` gives signed-out;
    - `/checkpoint/challenge/x` gives security-check;
    - `/feed/` with challenges 1 gives security-check;
    - `/login` with challenges 1 gives security-check;
    - `/jobs/view/1` gives unexpected-page.
  - `classify.spec.ts`, fixture tests: each `fixtures/*.html` is parsed with `linkedom`'s `parseHTML`, `SIGN_IN_FORM` and `CHALLENGE` are counted with `querySelectorAll`, and the result is classified with that fixture's path. The README lists the path and expected result per fixture.
  - `write-report.spec.ts`:
    - `pathPrefix` maps `/in/some-handle/` to `/in/`, `/feed/foryou/` to `/feed/`, and `/` to `/`.
    - `writeRunReport` writes valid JSON into a temp dir whose file name has no `:`.
    - The JSON has exactly the keys of `SessionReport`.
  - `session.spec.ts`, with a fake `SessionPage` and `wait` resolving at once:
    - `signed in`: the result is `signed-in`, `pathPrefix` is `/feed/`, and `goto` was called once with `FEED_URL`.
    - `stopped mid-load`: `goto` rejects and `stopReason` returns `debugger detached: canceled_by_user`. The result is `stopped`, `stopReason` is copied over, `goto` was called once, and `close` throwing doesn't reject `runSession`.
    - `navigation error without stop`: the result is `unexpected-page`.
    - `waits are random within bounds`: `randomInt` is called with `(4000, 8000)` and `(1500, 4000)`.
- [ ] **Step 2: Run them.** `pnpm nx test runner`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above, plus `commands/session.ts`, which adapts the Patchright `Page` to `SessionPage` (`path()` from `new URL(page.url()).pathname`, `count()` from `page.locator(sel).count()`). Wire `main.ts`.
- [ ] **Step 4: Verify.** `pnpm nx test runner` and `pnpm nx lint runner`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(runner): runner session with classification and redacted report`.

### Task 7: `runner bot-check`

**Files:**

- Create: `apps/runner/src/bot-check/parse.ts`, `apps/runner/src/commands/bot-check.ts`, `apps/runner/src/bot-check/fixtures/` (hand-made minimal samples: `rebrowser-clean.json`, `rebrowser-leak.json`, `dabi-human.txt`, `dabi-bot.txt`, `browserscan-normal.txt`)
- Modify: `apps/runner/src/main.ts`
- Test: `apps/runner/src/bot-check/parse.spec.ts`

**Interfaces:**

- Consumes: `connectBridge` (Task 5).
- Produces:

  ```ts
  export interface CheckResult {
    page: string;
    passed: boolean;
    detail: string[];
  }
  export function parseRebrowser(json: string): CheckResult;
  // Entries are [{ type, rating, note }]; failed = any rating === 1; detail = failed types.
  export function parseDabi(text: string): CheckResult;
  // passed iff text contains `"isBot": false`; detail = keys whose value is true.
  export function parseBrowserscan(text: string): CheckResult;
  // passed iff the first non-empty line after "Test Results:" is "Normal".
  ```

- CLI: `bot-check` opens one run window. It visits, in order:
  - `https://bot-detector.rebrowser.net/`, waits 4 s, and reads `#detections-json` with `inputValue()`;
  - `https://deviceandbrowserinfo.com/are_you_a_bot`, waits 7 s, and reads `body` with `innerText()`;
  - `https://www.browserscan.net/bot-detection`, waits 9 s, and reads `body` with `innerText()`.

  It prints a table of page, pass/fail and detail, and exits 0 only if all three pass. It saves no page content.

- [ ] **Step 1: Write the failing tests.**
  - `rebrowser-clean` passes. `rebrowser-leak`, with `runtimeEnableLeak` rating 1, fails with detail `['runtimeEnableLeak']`.
  - `dabi-human` passes. `dabi-bot`, with `"isAutomatedWithCDP": true`, fails with detail containing `isAutomatedWithCDP`.
  - `browserscan-normal` passes. The same text with `Robot` after `Test Results:` fails.
- [ ] **Step 2: Run them.** `pnpm nx test runner`. Expected: FAIL.
- [ ] **Step 3: Implement** `parse.ts` and `commands/bot-check.ts`, and wire `main.ts`.
- [ ] **Step 4: Verify.** `pnpm nx test runner` and `pnpm nx lint runner`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(runner): bot-check against public detection pages`.

### Task 8: Docs and roadmap

**Files:**

- Modify: `CLAUDE.md` (Stack; Running against LinkedIn; Commands), `docs/roadmap/README.md`

- [ ] **Step 1: Update `CLAUDE.md`.**
  - Stack: replace "browsers with Playwright" with "Patchright (Playwright API) through our own bridge extension in the author's everyday Chrome (slice 03)".
  - Commands: add `pnpm nx run runner:bridge-install`, `runner:bridge-check`, `runner:bot-check` and `runner:session`, one line each.
  - Running against LinkedIn:
    - Claude may run `runner:session` only when the author asks in that session.
    - `bridge-install`, `bridge-check` and `bot-check` never touch LinkedIn and need no ask.
    - Replace the "`RUNNER_NAME` … filled in by slice 03" sentence with the values that were set.
    - Add: no scripts in LinkedIn's page; read through locators only.
- [ ] **Step 2: Update `docs/roadmap/README.md`** exactly as the spec's "Roadmap changes" section says:
  - In the locked decisions, Playwright becomes Patchright through the bridge, and the "Two things for slice 03 to settle" bullets become what was settled, with a link to the spec.
  - Add the 03b row to the Phase 1 table, plus a `### 03b Human pace from the author's own applications` section with the scope and spec answers copied from the spec.
  - Slice 06 depends on `03, 03b, 05`. Change the note "03 and 04–05 are independent" to "03→03b and 04→05 are independent of each other".
  - Slice 03's "Locked" line says Patchright.
- [ ] **Step 3: Verify.** `pnpm nx format:check`. Expected: PASS.
- [ ] **Step 4: Commit** `docs: Patchright, the bridge and slice 03b in CLAUDE.md and roadmap`.

### Task 9: Live checks on the author's machine, signed-out fixtures, PR

This task needs the author for the marked steps. Claude doesn't run `session` unless the author asks in this session.

**Files:**

- Create: `apps/runner/src/session/fixtures/signed-out-authwall.html`, `signed-out-login.html` (scrubbed from the author's saves)
- Modify: `apps/runner/src/session/fixtures/README.md`; `apps/runner/src/relay/policy.ts` and `apps/bridge-extension/src/policy.js` only if Step 4 requires it

- [ ] **Step 1 (author):**
  - Remove the "Spike bridge" extension from `chrome://extensions` and delete `C:\Users\proup\10xapply-spike`.
  - Run `pnpm nx run runner:bridge-install`, then Load unpacked from the printed folder.
- [ ] **Step 2: Bridge check.** Run `pnpm nx run runner:bridge-check`, with the author's hands off the run window. Expected: `bridge: connected` and exit code 0. Also check the reconnect: with the runner stopped, the badge empties. After `bridge-check` starts again, the badge shows `on` within 30 s, without clicking.
- [ ] **Step 3: Bot check.** Run `pnpm nx run runner:bot-check`. Expected: all three pass, exit code 0. Record the table for the PR.
- [ ] **Step 4: Check the two script-planting refusals don't break Patchright.**
  - If Steps 2–3 or Step 6 fail with `refused: Runtime.addBinding` or `refused: Page.addScriptToEvaluateOnNewDocument`, remove only that method from both policy lists.
  - Re-run `pnpm nx test runner bridge-extension`, then repeat Steps 2–3. Note it in the PR, as the spec requires.
  - If nothing fails, leave both refused.
- [ ] **Step 5 (author): signed-out pages.** In a Chrome guest window, open `https://www.linkedin.com/feed/` (it lands on the authwall or login page) and then `https://www.linkedin.com/login`. Save each with Ctrl+S ("Webpage, HTML only") into `run-reports/raw-pages/`, and note the address bar path of each.
  - This replaces the spec's "into `private/`", because Claude can't read `private/`. A guest page holds no personal facts.
- [ ] **Step 6: Scrub the saves into committed fixtures.** Keep the `<form>` and `<input>` elements and the page's outer structure. Remove every `<script>`, inline JSON, `<meta>` tokens, `csrf`/`JSESSIONID`/`bcookie`-like values and tracking URLs. Add both to the README with their paths and the expected `signed-out` result. Then delete `run-reports/raw-pages/`.
- [ ] **Step 7: Verify.** `pnpm nx test runner`. Expected: PASS, including the new fixtures.
- [ ] **Step 8 (author runs it, or asks Claude to):** `pnpm nx run runner:session`, hands off the run window, window visible. Expected: `session: signed-in`. The report in `run-reports/` holds only the keys of `SessionReport`, with `pathPrefix` `/feed/`.
- [ ] **Step 9: Full check.** `pnpm nx run-many -t lint test typecheck`, `pnpm test:hooks` and `pnpm nx format:check`. Expected: all PASS.
- [ ] **Step 10: Commit** `test(runner): signed-out fixtures from LinkedIn's public pages`, push with `git push -u origin feat/local-browser-and-session`, and open the PR to `main` with `gh pr create`. The PR body includes:
  - the bot-check table;
  - the bridge-check and session results;
  - any policy change from Step 4;
  - the deviations: `alarms` permission, raw pages in `run-reports/raw-pages/`, and the extra safe-subcommand names;
  - a reminder that the author watches LinkedIn for warnings over the next days.
