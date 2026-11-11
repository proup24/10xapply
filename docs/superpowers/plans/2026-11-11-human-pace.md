# Human Pace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runner moves, clicks, scrolls and types at the author's own pace, which is learned from recordings of the author applying by hand. Each run comes out different, and the pace is proven on public behaviour-test pages, on a local practice page, and by the author watching it. Nothing in this slice drives LinkedIn.

**Architecture:**

- **Recorder.** The bridge extension gets a recorder: a content script in the isolated world, registered only while a recording command runs. It streams timing and event-shape data (never text, never keys) over the existing relay WebSocket.
- **Recording and profile.** The runner writes recordings to the git-ignored, Claude-readable `pace-recordings/`, and builds a pace profile from them: empirical samples per measure plus a few fitted models.
- **Pace module.** `apps/runner/src/pace/` is the only code allowed to touch a page. It draws every delay and path from the profile.
- **Proof.** `bot-check` (now with two behaviour pages) and a local practice page served by the relay give the runner somewhere to act. `pace compare` puts the runner's recordings next to the author's.

**Tech Stack:** Nx 24.0.2, pnpm 12, Node 24, TypeScript (nodenext, strict), Vitest 5, `patchright-core` 1.64.3 (exact), `ws` 8, `tsx` 4, `linkedom` (tests), Chrome MV3 (`chrome.scripting`).

**Spec:** `docs/superpowers/specs/2026-11-11-human-pace-design.md` (builds on `docs/superpowers/specs/2026-11-11-local-browser-and-session-design.md`)

## Global Constraints

- Branch `feat/slice-03b-human-pace` from `main`. The first commit holds the spec and this plan. Never work on `main`.
- `patchright-core` stays at exactly `1.64.3`. No new runtime dependency unless a task names it.
- **No runner action touches LinkedIn in this slice.** The runner drives only `about:blank`, the public test pages and the relay's own `/practice/` and `/typing/` pages.
- **No scripts in any page.** The existing ESLint ban (`evaluate`, `evaluateHandle`, `$eval`, `$$eval`, `evaluateAll`, `exposeFunction`, `exposeBinding`, `addInitScript`) stays. The relay and extension refusal lists stay as they are.
- **What the recorder never captures:** typed text, `key` or `code` (only the class `space` / `backspace` / `other`), page text, labels, option labels, element ids or classes, full URLs (only the path pattern, with ids replaced by `:id`), cookies or storage.
- **What the recorder may capture:**
  - timestamps;
  - event type, `isTrusted`, client, screen and movement coordinates, button, `pointerType`, wheel `deltaY`/`deltaMode`;
  - target kind;
  - whether a field had a value (yes/no);
  - option count and picked index;
  - description length (characters and rendered height);
  - window and screen geometry and `devicePixelRatio`;
  - an opaque per-sitting job key.
    Other numbers or yes/no values that hold no text may be added.
- **Extension manifest:**
  - MV3, permissions exactly `["debugger", "tabs", "alarms", "scripting"]`;
  - `host_permissions` exactly the recorder's match list (Task 3);
  - still no `content_scripts` key, no `web_accessible_resources` and no `key`.
- The recorder's match list is a constant inside the extension. The relay can start or stop recording but can't choose where.
- `pace-recordings/` sits at the repo root, is git-ignored, may be read by Claude, and is never committed. Committed test data is made up by hand.
- **The runner never seeds its randomness.** Only tests inject a seeded `Rng`. There are no fake typos.
- **Mouse only.** The pace module never presses Tab or Enter to move between fields or to submit.
- Claude may run every `pace` command and `bot-check` without asking. Claude never runs `session` in this slice unless the author asks.
- Commands use `pnpm` (`pnpm nx …`). Prettier runs on edited files automatically.

## Review Focus

1. **Chrome restarts the extension's service worker mid-sitting.** The content script is gone and the socket drops. `pace record` must say "recording stopped: extension disconnected", keep what it already has, and exit 2. It must never sit there counting nothing. Tested in Task 4 (`record stops on extension disconnect`).
2. **The author starts recording with job tabs already open.** Registered content scripts don't reach pages already loaded. `pace record` prints "open or reload the job pages now" at start. The live count shows 0 until a page reports in. Tested in Task 4 (`record prints the reload hint`).
3. **A screen scaled to 125% or 150%, or a second monitor.** Coordinate checks use CSS pixels and the recorded `devicePixelRatio` and window position. They must not report a false leak. Tested in Task 10 (`coordinate check holds at dpr 1.25 on a second monitor`).
4. **A job page where the description couldn't be measured** (`desc: null`). `pace build` falls back to unscaled reading time and never crashes or divides by zero. Tested in Task 7 (`build without description lengths`).
5. **The run window is moved or the page scrolls between finding a target and clicking it.** The pace module reads the target's box again just before the final approach. It never clicks stale coordinates. Tested in Task 8 (`click re-reads the box before arriving`).

---

## File map

```
apps/bridge-extension/src/
  manifest.json            + scripting, host_permissions
  manifest.spec.js         updated assertions
  background.js            + recorder start/stop, port from content script, browser.version
  bridge-core.js           + 'recorder.start' / 'recorder.stop' / 'browser.version' commands
  recorder-matches.js      RECORDER_MATCHES constant
  recorder-capture.js      pure: DOM event -> RecordedEvent (tested with linkedom)
  recorder-content.js      content script: listeners, batching, port to background
  *.spec.js                tests per file
apps/runner/src/
  relay/relay.ts           + recorder channel, real getVersion, Inspector.enable, /practice and /typing
  relay/static/practice/   index.html (multi-step form), practice.css
  relay/static/typing/     index.html
  bridge/bridge.ts         + recording API on Bridge
  bot-check/               + dabi-interactions and incolumitas targets, parsers, fixtures
  pace/
    recording.ts           shared types (RecordedEvent, Recording, Sitting meta)
    paths.ts               PACE_DIR, file naming, atomic write
    writer.ts              groups batches by job key, writes files
    phases.ts              derive phases from ctx
    measures.ts            recordings -> named samples
    profile.ts             PaceProfile type, build, load
    rng.ts                 Rng, kde sampling
    mouse.ts               path generation (pure)
    typing.ts              key schedule (pure)
    pace.ts                createPace(page, profile) — the only page-touching code
    compare.ts             shape checks + KS
    ks.ts                  two-sample Kolmogorov–Smirnov
    fixtures/              hand-made recordings + profile
  commands/pace.ts         record | summary | build | practice | compare
  commands/bot-check.ts    pace-driven behaviour pages, --repeat, --record
  commands/bridge.ts       + bridge check --crash
apps/runner/eslint.config.mjs  + input ban outside src/pace/
.claude/hooks/guard.mjs        + pace subcommands
.gitignore                     + pace-recordings/
CLAUDE.md, docs/roadmap/README.md
```

## Shared contract (defined in Task 3, used everywhere after)

`apps/runner/src/pace/recording.ts` (the extension mirrors the shape in JSDoc in `recorder-capture.js`):

```ts
export type KeyClass = 'space' | 'backspace' | 'other';
export type TargetKind =
  | 'button'
  | 'link'
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'other';
export interface Target {
  kind: TargetKind;
  hasValue?: boolean; // fields only, at focusin
  options?: number; // select / radio group
  picked?: number; // on change
  inDescription?: boolean; // inside the measured description element
}
export interface Ctx {
  path: string;
  dialog: boolean;
  progress: number | null;
}
export interface RecordedEvent {
  t: number; // performance.timeOrigin + performance.now(), ms
  type:
    | 'pointermove'
    | 'pointerover'
    | 'pointerdown'
    | 'pointerup'
    | 'mousemove'
    | 'mousedown'
    | 'mouseup'
    | 'click'
    | 'wheel'
    | 'keydown'
    | 'keyup'
    | 'focusin'
    | 'change'
    | 'scroll';
  trusted: boolean;
  x?: number;
  y?: number;
  sx?: number;
  sy?: number;
  mx?: number;
  my?: number;
  button?: number;
  pointerType?: string;
  dy?: number;
  dm?: number;
  key?: KeyClass; // key events only — never the key itself
  target: Target;
  ctx: Ctx;
}
export interface PageInfo {
  t: number;
  ctx: Ctx;
  desc: { chars: number; height: number } | null;
  win: {
    screenX: number;
    screenY: number;
    outerWidth: number;
    outerHeight: number;
    innerWidth: number;
    innerHeight: number;
  };
  screen: { width: number; height: number };
  dpr: number;
}
export interface RecorderBatch {
  pageId: string;
  jobKey: string | null;
  page?: PageInfo;
  events: RecordedEvent[];
}
export type Source = 'linkedin' | 'practice' | 'typing' | 'test-page';
export type Actor = 'author' | 'runner';
export interface Recording {
  version: 1;
  actor: Actor;
  source: Source;
  sittingId: string;
  jobKey: string;
  pages: PageInfo[];
  events: RecordedEvent[];
}
```

---

### Task 1: Slice 03 follow-ups (flaky test, crash stop, real `Browser.getVersion`)

**Files:**

- Modify: `apps/runner/src/bridge/bridge.spec.ts`, `apps/runner/src/relay/relay.ts`, `apps/runner/src/relay/browser-model.ts`, `apps/bridge-extension/src/bridge-core.js`, `apps/bridge-extension/src/background.js`, `apps/runner/src/commands/bridge.ts`, `apps/runner/src/main.ts`
- Test: `apps/runner/src/bridge/bridge.spec.ts`, `apps/runner/src/relay/relay.spec.ts`, `apps/bridge-extension/src/bridge-core.spec.js`

**Interfaces:**

- Produces: extension command `'browser.version'` → `{ userAgent: string, product: string }` (`product` is `Chrome/<full version>`). `runner bridge check --crash`.

- [ ] **Step 1: Replace the `sleep(50)` waits.** In `bridge.spec.ts`, `fakeExtension(port)` retries the connection on `ECONNREFUSED` every 10 ms for up to 2 s. Delete all three `await sleep(50)` lines.
- [ ] **Step 2: Run the file 20 times.** Run `for i in $(seq 20); do pnpm nx test runner -- src/bridge/bridge.spec.ts || break; done`. Expected: 20 passes.
- [ ] **Step 3: Write failing relay tests:**
  - `sends Inspector.enable to a new run tab after attach`: the fake extension sees `debugger.send` with `method: 'Inspector.enable'` and the new tab's `tabId`, right after `debugger.attach`.
  - `Browser.getVersion returns the extension's real values`: the fake extension answers `browser.version` with `{userAgent:'Mozilla/5.0 … Chrome/157.0.1.2 …', product:'Chrome/157.0.1.2'}`, and the CDP reply is `{protocolVersion:'1.3', product:'Chrome/157.0.1.2', userAgent:<same>, revision:'', jsVersion:''}`.
  - `Browser.getVersion falls back when the extension can't answer`: the fake extension replies with an error, and the result has the old shape. The test asserts that the reply is not an error.
- [ ] **Step 4: Write a failing extension test.** In `bridge-core.spec.js`, `browser.version answers from the injected provider`: `createBridgeCore` gets an optional third argument `{ version: () => Promise<{userAgent, product}> }`.
- [ ] **Step 5: Implement.**
  - **BrowserModel:** after a successful `debugger.attach` in the `Target.createTarget` path, it sends `Inspector.enable` through `debugger.send`. A failure here is ignored.
  - **Relay:** asks `browser.version` once per extension connection (lazily, on the first `Browser.getVersion`) and caches the answer.
  - **`background.js`:** provides `version` from `navigator.userAgent` and `navigator.userAgentData.getHighEntropyValues(['fullVersionList'])`, using the entry whose brand is `Google Chrome`, or else `Chromium`.
- [ ] **Step 6: Add `bridge check --crash`.** `bridgeCheck({ crash: true })` opens `about:blank`, sends `Page.crash` through `page.context().newCDPSession(page)`, waits up to 5 s for `bridge.stopReason()` to become non-null, and prints `crash stop: ok (<reason>)` (exit 0) or `crash stop: not seen` (exit 2). `main.ts` routes `bridge check --crash`. Add the Nx target `bridge-check-crash`.
- [ ] **Step 7: Run tests.** Run `pnpm nx run-many -t test lint typecheck -p runner bridge-extension`. Expected: PASS.
- [ ] **Step 8: Live check (Claude may run it; it never touches LinkedIn).** Run `pnpm nx run runner:bridge-install`, ask the author to click Reload on the extension, then run `pnpm nx run runner:bridge-check-crash`. Expected: `crash stop: ok (debugger detached: crashed)`. If it prints `not seen`, debug with superpowers:systematic-debugging before moving on.
- [ ] **Step 9: Commit:** `fix(runner): reliable bridge tests, crash stop via Inspector.enable, real Browser.getVersion`.

### Task 2: Leak check on the interactions page — GATE

**Files:**

- Modify: `apps/runner/src/commands/bot-check.ts`, `apps/runner/src/bot-check/parse.ts`
- Create: `apps/runner/src/bot-check/fixtures/dabi-interactions-clean.txt`, `dabi-interactions-leak.txt`
- Test: `apps/runner/src/bot-check/parse.spec.ts`

**Interfaces:**

- Produces: `parseDabiInteractions(text: string): CheckResult` with `page: 'dabi-interactions'`. It passes only when `suspiciousClientSideBehavior`, `superHumanSpeed` and `hasCDPMouseLeak` are all `false` and `isBot` is `false`. `detail` lists every flag that is `true`.
- Produces: `Target` gains an optional `act?: (page: Page) => Promise<void>`, run after load and before `read`.

- [ ] **Step 1: Capture the result text once.** Add the target `{ name: 'dabi-interactions', url: 'https://deviceandbrowserinfo.com/are_you_a_bot_interactions', waitMs: 3_000 }`. Its temporary `act` fills Email with `pace.test.<random 6 digits>@example.com` and Password with a random 12-character string, using `page.mouse.move(x, y, { steps: 25 })` to the box centre, `mouse.down/up` and `keyboard.type(text, { delay: 120 })`, then clicks Login the same way and waits 5 s. Run `pnpm nx run runner:bot-check` and save the `read` text to the scratchpad. Scrub any IP address or fingerprint hash it shows and save it as the matching fixture (clean or leak). Hand-edit a copy for the other fixture by flipping `hasCDPMouseLeak` and `suspiciousClientSideBehavior`.
- [ ] **Step 2: Write failing parser tests:**
  - `dabi-interactions passes when all behaviour flags are false` (on the clean fixture);
  - `dabi-interactions fails and names hasCDPMouseLeak` (on the leak fixture: `passed: false`, `detail` contains `'hasCDPMouseLeak'`);
  - `dabi-interactions is unparseable without the flags` (`detail: ['unparseable']`).
- [ ] **Step 3: Implement `parseDabiInteractions`.** Use the same regex style as `parseDabi`. Any of the three flags missing means unparseable.
- [ ] **Step 4: Run tests.** Run `pnpm nx test runner -- src/bot-check`. Expected: PASS.
- [ ] **Step 5: Live run, three times.** Run `pnpm nx run runner:bot-check` three times. Record the table in the PR notes.
- [ ] **Step 6: GATE.** If `hasCDPMouseLeak` shows `true` on any run, **STOP**. Write what was seen (the table, and the window geometry if readable) and bring it back to the author. Don't continue to Task 3. A fix must keep slice 03's rules (no page scripts, no new extension exposure). Proposing one is fine, but the author decides. If the only failures are `suspiciousClientSideBehavior` or `superHumanSpeed`, continue: those are what the pace module is for.
- [ ] **Step 7: Commit:** `test(runner): deviceandbrowserinfo interactions page in bot-check`.

### Task 3: The recorder in the extension

**Files:**

- Create: `apps/bridge-extension/src/recorder-matches.js`, `recorder-capture.js`, `recorder-content.js`, `recorder-capture.spec.js`, `apps/runner/src/pace/recording.ts`
- Modify: `apps/bridge-extension/src/manifest.json`, `manifest.spec.js`, `bridge-core.js`, `bridge-core.spec.js`, `background.js`, `apps/runner/src/bridge/install.ts` (copy the new files; nothing new is excluded)

**Interfaces:**

- Produces: `RECORDER_MATCHES = ['https://www.linkedin.com/jobs/*', 'https://deviceandbrowserinfo.com/are_you_a_bot_interactions*', 'https://bot.incolumitas.com/*', 'http://127.0.0.1/*']`. Task 5's live check confirms that `http://127.0.0.1/*` matches any port. If it doesn't, use `http://127.0.0.1:*/*` and update `host_permissions` to match.
- Produces: `capture(event, ctxOf, descEl): RecordedEvent | null` and `pageInfo(win, doc, descEl): PageInfo`, both pure over DOM-like objects, plus `pathPattern(pathname: string): string`.
- Produces: extension commands `'recorder.start'` (params `{ salt: string }`; any match list sent with it is ignored) and `'recorder.stop'`, and the extension→relay message `{ method: 'recorder.batch', params: RecorderBatch }`.

- [ ] **Step 1: Write the failing manifest test.** `manifest.spec.js` now expects:
  - `permissions` equal to `['debugger','tabs','alarms','scripting']`;
  - `host_permissions` equal to `RECORDER_MATCHES`;
  - still no `content_scripts`, `web_accessible_resources` or `key`.
- [ ] **Step 2: Write failing capture tests** in `recorder-capture.spec.js`, using linkedom events with the properties set by hand:
  - `keydown records only the key class`: `{key:'a'}` gives `key:'other'`, `' '` gives `'space'`, `'Backspace'` gives `'backspace'`, and the output's JSON doesn't contain the string `"a"` as a value;
  - `never copies text`: a click on `<button>Apply now</button>` inside `<label>Secret</label>` gives JSON that contains neither `Apply` nor `Secret`;
  - `target kinds`: input types text/email/tel → `text`, number → `number`, textarea, select, radio, checkbox, file, `<button>` and `role=button` → `button`, `<a>` → `link`;
  - `focusin records hasValue only`: an input with value `x` gives `hasValue: true` and nothing about the value;
  - `change on select records options and picked`: 4 options, index 2 → `{options:4, picked:2}`;
  - `radio group counts same-name radios`;
  - `pathPattern`: `/jobs/view/4012345678/` → `/jobs/view/:id/`, `/jobs/search/?currentJobId=123` → `/jobs/search/`;
  - `ctx.dialog true inside [role=dialog]`, and `ctx.progress` reads `aria-valuenow` from a `[role=progressbar]` inside the dialog, or `null`;
  - `pageInfo with no description gives desc null`.
- [ ] **Step 3: Implement `recorder-capture.js` and `recorder-matches.js`.**
  - Finding the description element: the first match of `#job-details`, `[class*="jobs-description"]` or `article`. Refine this on the author's first recording in the Checkpoint.
  - `jobKey`: the first 12 hex characters of SHA-256(salt + job id), where the job id comes from `/jobs/view/<id>` or `currentJobId` and `salt` is the random per-sitting value from `recorder.start` (never stored). Practice and typing pages use the `run` query parameter; test pages use `null`.
- [ ] **Step 4: Implement `recorder-content.js`.** It adds capture-phase, passive listeners on `window` for every event type in the contract. It never calls `preventDefault` or `stopPropagation` and never writes to the DOM. Events go into a buffer that is flushed every 500 ms and on `pagehide`, through `chrome.runtime.connect({ name: 'recorder' })`. It sends `pageInfo` on load and again whenever the description's height changes by more than 20% (checked on each flush, not with an observer).
- [ ] **Step 5: Write failing bridge-core tests:**
  - `recorder.start registers the content script with the fixed matches`: the fake `chrome.scripting.registerContentScripts` is called with `[{ id:'pace-recorder', js:['recorder-content.js'], matches: RECORDER_MATCHES, world:'ISOLATED', runAt:'document_start', persistAcrossSessions:false, allFrames:false }]`, and `params.matches` from the relay is ignored;
  - `recorder.stop unregisters`;
  - `recorder.start twice is idempotent`.

  `createBridgeCore`'s `chromeApi` gains `scripting`.

- [ ] **Step 6: Implement in `bridge-core.js` and `background.js`.**
  - At top level, `background.js` calls `chrome.scripting.unregisterContentScripts({ ids: ['pace-recorder'] }).catch(() => {})`, which clears anything left over after a restart.
  - On socket close it unregisters too.
  - `chrome.runtime.onConnect` accepts only `name === 'recorder'` ports, and only while recording is on. It forwards each message as `recorder.batch`.
  - The badge reads `rec` while recording and `on` otherwise.
- [ ] **Step 7: Run tests.** Run `pnpm nx run-many -t test lint -p bridge-extension`. Expected: PASS.
- [ ] **Step 8: Commit:** `feat(bridge-extension): timing-only recorder, registered only while recording`.

### Task 4: Relay recorder channel, `pace record`, writer, guard

**Files:**

- Create: `apps/runner/src/pace/paths.ts`, `writer.ts`, `apps/runner/src/commands/pace.ts`
- Modify: `apps/runner/src/relay/relay.ts`, `apps/runner/src/bridge/bridge.ts`, `apps/runner/src/main.ts`, `apps/runner/package.json` (targets), `.gitignore`, `.claude/hooks/guard.mjs`, `.claude/hooks/guard.test.mjs`
- Test: `relay.spec.ts`, `pace/writer.spec.ts`, `commands/pace.spec.ts`

**Interfaces:**

- Consumes: the Task 3 contract.
- Produces: on `Relay`, `startRecording(salt: string): Promise<void>`, `stopRecording(): Promise<void>` and `onRecorderBatch(fn: (b: RecorderBatch) => void): () => void`. `Bridge` gains the same three, passed through.
- Produces: `PACE_DIR` (absolute repo-root `pace-recordings`) and `writeAtomic(path: string, data: string): void` (tmp file plus rename).
- Produces: `createWriter({ dir, actor, source: (ctx: Ctx) => Source, sittingId }): { add(b: RecorderBatch): void; counts(): Counts; flush(): string[] }`. `flush` writes one `Recording` per `jobKey` to `<dir>/<actor>/<source>/<sittingId>-<jobKey>.json` and returns the paths. Batches with a `null` jobKey go under `jobKey: 'none'`.
- Produces: `recordCommand(opts: { typing?: boolean, deps? }): Promise<number>`.

- [ ] **Step 1: Write failing relay tests:**
  - `startRecording sends recorder.start with the salt`;
  - `recorder.batch reaches onRecorderBatch listeners`;
  - `recorder.batch is never logged beyond the method name`: the log lines contain `recorder.batch` and none of the batch's values.
- [ ] **Step 2: Write failing writer tests:**
  - `groups by jobKey`;
  - `source from ctx path`: a path starting `/practice` gives `practice`, `/typing` gives `typing`, `/jobs` gives `linkedin`, anything else gives `test-page`;
  - `writes atomically`: a crash simulated between write and rename leaves no `.json` file, only `.tmp`;
  - `counts` reports `{ pages, clicks, keyGaps, wheels }`.
- [ ] **Step 3: Write failing `pace record` tests**, with a fake relay:
  - `record prints the reload hint`: the output contains `open or reload the job pages now`;
  - `record stops on extension disconnect`: emitting `extension-disconnected` gives exit 2, the output contains `recording stopped: extension disconnected`, and `flush` was called;
  - `record --typing prints the typing page URL`: `http://127.0.0.1:<port>/typing/`;
  - `SIGINT flushes and exits 0`.
- [ ] **Step 4: Implement.**
  - `pace record` starts the relay without Patchright (`startRelay` plus `waitForExtension`), generates `sittingId` (UTC timestamp) and `salt`, and starts recording.
  - It prints the live counts every 5 s on one line (`\r`).
  - On stop, it calls `stopRecording`, then `flush`, and prints the file paths.
  - Add the Nx targets `pace-record` (`tsx src/main.ts pace record`) and `pace-record-typing`.
- [ ] **Step 5: Update the guard and `.gitignore`.**
  - Add `'pace'`, `'pace-record'`, `'pace-record-typing'`, `'pace-summary'`, `'pace-build'`, `'pace-practice'`, `'pace-compare'` and `'bridge-check-crash'` to `RUNNER_SAFE_SUBCOMMANDS`.
  - Guard tests: `pnpm nx run runner:pace-record` and `tsx src/main.ts pace compare` are allowed, and `tsx src/main.ts apply <url>` is still blocked.
  - Add `pace-recordings/` to `.gitignore`.
- [ ] **Step 6: Run tests.** Run `pnpm test:hooks && pnpm nx run-many -t test lint typecheck -p runner bridge-extension`. Expected: PASS.
- [ ] **Step 7: Commit:** `feat(runner): pace record writes timing-only recordings to pace-recordings/`.

### Task 5: Practice and typing pages

**Files:**

- Create: `apps/runner/src/relay/static/practice/index.html`, `apps/runner/src/relay/static/typing/index.html`
- Modify: `apps/runner/src/relay/relay.ts` (static GET for `/practice/` and `/typing/`; everything else stays 404)
- Test: `relay.spec.ts`

**Interfaces:**

- Produces: `GET /practice/?run=<n>` and `GET /typing/?run=<n>` serve the static files, with no token. The page markup contract that Task 9 drives is listed in Step 2.

- [ ] **Step 1: Write failing tests:**
  - `serves /practice/ as text/html`;
  - `serves /typing/`;
  - `other paths stay 404`;
  - `no path traversal`: `/practice/../relay.ts` gives 404.
- [ ] **Step 2: Build `practice/index.html`.** It's plain HTML and CSS with no LinkedIn branding or text, and no external requests. Structure:
  - a job page with a ~2,500-character lorem-style description collapsed to 6 lines, a `button#more`, and a `button#apply`;
  - Apply opens a `div[role=dialog]` with a `[role=progressbar][aria-valuenow]`;
  - **step 1:** a prefilled `input#email`, a `select#phone-country` (5 options) and an empty `input#phone`;
  - **step 2:** a `button#upload` wrapping a hidden `input#resume[type=file]`, and an empty `input#years[type=number]`;
  - **step 3:** two radio groups (`name=auth`, `name=relocate`, 2 options each), a `textarea#why`, and a checkbox `#follow`;
  - **review step:** `button#submit`, which shows "Submitted (practice — nothing is sent)" and posts nothing;
  - `button#next` / `button#review` move between steps.

  The fields copy Easy Apply's field kinds, not its look.

- [ ] **Step 3: Build `typing/index.html`.** Three `textarea`s with the prompt "Type anything; nothing is kept." No form, no network.
- [ ] **Step 4: Run tests.** Run `pnpm nx test runner -- src/relay`. Expected: PASS.
- [ ] **Step 5: Live check (Claude may run it).** Run `pnpm nx run runner:pace-record-typing`. Ask the author to open the printed URL and type for 10 s, then Ctrl+C. Expected: a file under `pace-recordings/author/typing/`, with `keydown` events that carry `key` classes only, and `grep -c '"key":"other"'` > 0. If it gives 0 events, the match pattern doesn't cover the port. Switch to `http://127.0.0.1:*/*` (see Task 3) and repeat.
- [ ] **Step 6: Commit:** `feat(runner): local practice and typing pages`.

### Checkpoint: the author's sitting (author, about 30 minutes)

- [ ] The author runs `pnpm nx run runner:pace-record` and applies to 5–10 real jobs by hand, the usual way, then presses Ctrl+C.
- [ ] The author runs it again and fills `http://127.0.0.1:9333/practice/?run=1` through `?run=4` by hand (any made-up answers), then presses Ctrl+C.
- [ ] Claude reads one LinkedIn recording and checks it:
  - phases can be told apart;
  - `desc` was found (if not, refine the description selector in `recorder-capture.js` and commit);
  - no text values are present: run `grep -E '"(key|code)":"[^sbo]'` and expect no output.
- [ ] Tasks 6–7 then run against these real files as well as the made-up fixtures.

### Task 6: Phases and `pace summary`

**Files:**

- Create: `apps/runner/src/pace/phases.ts`, `apps/runner/src/pace/measures.ts`, `apps/runner/src/pace/fixtures/linkedin-app-1.json` (made up), `practice-1.json`
- Modify: `commands/pace.ts`, `main.ts`, `package.json` (`pace-summary`)
- Test: `pace/phases.spec.ts`, `pace/measures.spec.ts`, `commands/pace.spec.ts`

**Interfaces:**

- Produces: `type Phase = 'job-page' | 'description' | 'easy-apply-step' | 'review' | 'submitted'` and `phaseOf(e: RecordedEvent, pages: PageInfo[]): { phase: Phase; step: number | null }`.
- Produces: `extractMeasures(recs: Recording[]): Measures`, where `Measures` is `Record<MeasureName, number[]>` plus `models` inputs. `MeasureName` is exactly:
  - `pageToFirstAction`, `readDwell`, `readChars`, `expandRate`, `scrollRate`;
  - `wheelGap`, `wheelBurst`, `wheelDelta`;
  - `moveDuration`, `moveDistance`, `moveTargetSize`, `pathDeviation`, `overshootRate`, `overshootDist`, `sampleInterval`, `zeroMovementShare`;
  - `hoverToPress`, `pressRelease`, `clickOffsetX`, `clickOffsetY`;
  - `keyHold`, `keyGapInWord`, `keyGapAfterSpace`, `keyGapAroundBackspace`;
  - `fieldDwellPrefilled`, `fieldDwellBeforeTyping`, `afterTypingToMove`, `pickDwell`;
  - `stepTime`, `appTime`, `longPauseRate`, `longPause`, `appSpeedFactor`.

  Rates are one value per application. `appSpeedFactor` is each application's median move duration divided by the median across all applications.

- Produces: `MINIMUMS: Partial<Record<MeasureName, number>>`:
  - `readDwell: 8`;
  - `moveDuration: 60`;
  - `pressRelease: 60`;
  - `keyGapInWord: 300`;
  - `keyGapAfterSpace: 40`;
  - `wheelGap: 100`;
  - `fieldDwellBeforeTyping: 10`;
  - `appTime: 5`.

  Practice applications count separately, with `stepTime: 9` (3 sittings × 3 steps).

- [ ] **Step 1: Write failing phase tests:**
  - `/jobs/` with no dialog is `job-page`;
  - an event on a target with `inDescription`, or after `desc.height` grew by more than 20%, is `description`;
  - a dialog with progress 33 is `easy-apply-step` step 1, 66 is step 2;
  - a dialog with progress 100 is `review`;
  - a click on a button during `review` followed by the dialog closing is `submitted`.
- [ ] **Step 2: Write failing measure tests** on the made-up fixture with hand-computed values:
  - `pressRelease` equals each click's `mouseup.t - mousedown.t`;
  - `keyGapAfterSpace` takes only the gap after a `space` keydown;
  - `moveDuration` is from movement start (first `pointermove` after a 150 ms still period) to `pointerdown`, with `moveDistance` measured in CSS pixels;
  - `overshootRate` is the share of moves whose path passes the final point by more than 3 px before coming back;
  - `readDwell` is from the first `description`-phase event to Apply's `pointerdown`, paired with `readChars` from `desc.chars`.
- [ ] **Step 3: Implement `phases.ts` and `measures.ts`.** Movement segmentation: a move starts after ≥ 150 ms with no `pointermove` and ends at the next `pointerdown`.
- [ ] **Step 4: Write a failing summary test.** `summary prints count, minimum and enough/short per measure`. With the fixture, `keyGapInWord` shows `short`, and the output names `pace-record-typing` as the fix.
- [ ] **Step 5: Implement `pace summary`.** It reads `PACE_DIR/author/**`. Add the target `pace-summary`.
- [ ] **Step 6: Run tests.** Run `pnpm nx test runner -- src/pace src/commands`. Expected: PASS.
- [ ] **Step 7: Run on the real sitting.** Run `pnpm nx run runner:pace-summary`. For each measure that shows `short`, ask the author for more data (`pace-record-typing` for typing, or a few more applications). Note the counts in the PR.
- [ ] **Step 8: Commit:** `feat(runner): phases, measures and pace summary`.

### Task 7: The profile (`pace build`)

**Files:**

- Create: `apps/runner/src/pace/rng.ts`, `apps/runner/src/pace/profile.ts`, `apps/runner/src/pace/fixtures/profile.json` (made up, small)
- Modify: `commands/pace.ts`, `main.ts`, `package.json` (`pace-build`)
- Test: `pace/rng.spec.ts`, `pace/profile.spec.ts`

**Interfaces:**

- Produces: `interface Rng { next(): number }`, `cryptoRng(): Rng` (from `crypto.getRandomValues`), and `seededRng(seed: number): Rng` (mulberry32, tests only).
- Produces: `sampleKde(samples: number[], rng: Rng, opts?: { min?: number; max?: number }): number`. It picks a sample, adds Gaussian noise with Silverman's bandwidth, and clamps to `[min ?? 0, max ?? Infinity]`. With fewer than 2 samples it throws.
- Produces:

```ts
export interface PaceProfile {
  version: 1;
  builtAt: string;
  sources: { applications: number; practice: number };
  samples: Partial<Record<MeasureName, number[]>>;
  fitts: { a: number; b: number; residuals: number[] }; // moveDuration = a + b*log2(D/W + 1) + residual
  reading: { base: number; perChar: number; residuals: number[] } | null;
  wheel: { deltaY: number; deltaMode: number }; // the author's notch
  practice: { stepTime: number[]; appTime: number[] }; // compare baseline only
}
```

- Produces: `buildProfile(recs: Recording[]): PaceProfile` and `loadProfile(path = join(PACE_DIR,'profile.json')): PaceProfile`. `loadProfile` throws `ConfigError('no pace profile: run pnpm nx run runner:pace-build')` when the file is missing.

- [ ] **Step 1: Write failing tests:**
  - `seededRng is repeatable and cryptoRng is not seeded`, a source-level check that `cryptoRng` takes no argument;
  - `sampleKde stays within clamps and its mean is within 10% of the samples' mean over 5,000 draws`;
  - `fitts fit recovers a and b from synthetic data within 5%`;
  - `build without description lengths`: every `desc: null` gives `reading: null` and no throw;
  - `wheel notch is the mode of deltaY`;
  - `practice recordings never feed samples`.
- [ ] **Step 2: Implement `rng.ts` and `profile.ts`.** The Fitts fit and reading fit are least squares. Residuals are kept as samples for `sampleKde`.
- [ ] **Step 3: Implement `pace build`.** It writes `PACE_DIR/profile.json` atomically and prints the number of samples per measure. Add the target `pace-build`.
- [ ] **Step 4: Run tests.** Run `pnpm nx test runner -- src/pace`. Expected: PASS.
- [ ] **Step 5: Run on the real data.** Run `pnpm nx run runner:pace-build`. Expected: `pace-recordings/profile.json` exists and the summary line shows no measure with 0 samples.
- [ ] **Step 6: Commit:** `feat(runner): pace profile from the author's recordings`.

### Task 8: The pace module and the input ban

**Files:**

- Create: `apps/runner/src/pace/mouse.ts`, `typing.ts`, `pace.ts`
- Modify: `apps/runner/eslint.config.mjs`, `apps/runner/src/lint-rules.spec.ts`
- Test: `pace/mouse.spec.ts`, `pace/typing.spec.ts`, `pace/pace.spec.ts`

**Interfaces:**

- Consumes: `PaceProfile`, `Rng`, `sampleKde`.
- Produces (`mouse.ts`, pure): `planPath(from: Pt, box: Box, profile: PaceProfile, rng: Rng): { points: { x: number; y: number; at: number }[]; end: Pt }`. `at` is ms from the start.
- Produces (`typing.ts`, pure): `planKeys(text: string, profile: PaceProfile, rng: Rng): { ch: string; gapBefore: number; hold: number }[]`.
- Produces (`pace.ts`):

```ts
export type Optional =
  'expand-description' | 'scroll-description' | 'idle-move';
export interface Pace {
  readonly mood: number;
  click(target: Locator): Promise<void>;
  type(field: Locator, text: string): Promise<void>; // clicks the field first
  glance(field: Locator): Promise<void>; // prefilled: move near, dwell, no typing
  pick(control: Locator, index: number): Promise<void>; // select or radio group
  upload(button: Locator, filePath: string): Promise<void>;
  scroll(area: Locator, notches?: number): Promise<void>;
  read(chars: number | null): Promise<void>;
  pause(): Promise<void>; // between actions, with long-pause tail
  maybe(action: Optional): boolean;
}
export function createPace(
  page: Page,
  profile: PaceProfile,
  deps?: {
    rng?: Rng;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Pace;
```

- [ ] **Step 1: Write failing `mouse.ts` tests** (with `seededRng`):
  - `path ends inside the box`;
  - `no straight lines`: the maximum perpendicular deviation is greater than 0 for 95% of 200 paths of length > 200 px;
  - `overshoot rate within ±0.05 of profile.overshootRate mean over 1,000 paths`;
  - `duration follows fitts within the residual range`;
  - `point gaps are drawn from sampleInterval`: the median gap is within 15% of the profile's median;
  - `two seeds give different paths`.
- [ ] **Step 2: Implement `planPath`.**
  - The path is a cubic Bézier from `from` to a click point. The click point is the box centre plus `clickOffsetX/Y` (normalised by half-size, clamped to ±0.8) drawn from the profile.
  - The control points are offset perpendicular to the line by a `pathDeviation` draw.
  - Time is laid out along the curve with a minimum-jerk velocity profile, `s(τ) = 10τ³ − 15τ⁴ + 6τ⁵`.
  - On an overshoot draw, the path continues past the end by `overshootDist`, then a short correction sub-move returns to the end (its own Fitts duration).
  - Points are emitted at `sampleInterval` draws.
- [ ] **Step 3: Write failing `typing.ts` tests:**
  - `gap after a space comes from keyGapAfterSpace`, a seeded check: the schedule for `"ab cd"` has gap 3 drawn from that measure;
  - `no backspaces are ever produced` (no fake typos);
  - `every character of the text appears once, in order`.
- [ ] **Step 4: Implement `planKeys`.**
- [ ] **Step 5: Write failing `pace.ts` tests** with a fake `Page` that records `mouse.move/down/up/wheel` and `keyboard.down/up` calls with times from a fake clock:
  - `click moves along the planned points, then hoverToPress, down, pressRelease, up`;
  - `click re-reads the box before arriving`: the box changes between the first and second `boundingBox()` calls, and the final point lies in the new box;
  - `type clicks the field first and never sends Tab or Enter`;
  - `glance sends no keys`;
  - `scroll sends wheel events of profile.wheel.deltaY with wheelGap gaps, after moving over the area`;
  - `read(null) uses readDwell samples; read(2500) uses the reading model`;
  - `mood scales dwell, read and pause durations but not sampleInterval or keyHold`;
  - `mood is drawn from appSpeedFactor`;
  - `upload clicks the button with the file chooser intercepted and sets the file`: it uses `page.waitForEvent('filechooser')` together with the click, then `chooser.setFiles(path)`. The OS dialog never opens;
  - `createPace without deps.rng uses cryptoRng`.
- [ ] **Step 6: Implement `createPace`.**
  - It tracks the mouse position. Its first position is a random point in the middle 60% of the viewport, reached by an ordinary `planPath` move from a random viewport edge.
  - The emitter is time-based: each point is sent when `now() >= start + at`. When CDP round trips lag behind, points are skipped, not delayed, so speed is kept.
  - `pick` on a `<select>`: click it, wait `pickDwell`, then `selectOption({ index })`. Then run the Step 7 check.
  - `pick` on a radio group: `click` the nth radio's label.
- [ ] **Step 7: Check event shape on the practice page (Claude may run it).** Using a scratch script in the scratchpad (not committed) that drives `/practice/` with `--record` semantics (or wait for Task 9 and do this there), look at the recorded `change` events on the select. If `trusted` is `false` for `selectOption`, try keyboard selection while the popup is open (`ArrowDown` × n, then `Enter` from inside `pick`, as an exception to mouse-only that is limited to an open select popup). Keep whichever gives `trusted: true` and the same event sequence as the author's practice recordings. If neither does, that's a GATE (spec: an event-shape giveaway with no fix): stop and bring it back to the author.
- [ ] **Step 8: Write the failing lint test.** In `lint-rules.spec.ts`: `bans input methods outside src/pace`. Linting a snippet `await page.locator('a').click()` at path `src/commands/x.ts` errors, and the same snippet at `src/pace/x.ts` passes. The banned property names are `click`, `dblclick`, `fill`, `type`, `press`, `pressSequentially`, `check`, `uncheck`, `selectOption`, `setInputFiles`, `hover`, `tap`, `dragTo`, plus any member access on `mouse` or `keyboard`.
- [ ] **Step 9: Implement the ESLint rule.** It's a second `no-restricted-syntax` block with `ignores: ['src/pace/**']`. The existing evaluate ban stays everywhere. Remove Task 2's temporary `mouse`/`keyboard` calls from `bot-check.ts`; the next task replaces them with pace.
- [ ] **Step 10: Run tests.** Run `pnpm nx run-many -t test lint typecheck -p runner`. Expected: PASS.
- [ ] **Step 11: Commit:** `feat(runner): pace module drives the mouse and keyboard from the author's profile`.

### Task 9: Pace drives `bot-check` and the practice run

**Files:**

- Modify: `apps/runner/src/commands/bot-check.ts`, `apps/runner/src/bot-check/parse.ts`, `commands/pace.ts`, `main.ts`, `package.json`
- Create: `apps/runner/src/bot-check/fixtures/incolumitas-human.txt`, `incolumitas-bot.txt`, `apps/runner/src/pace/practice-run.ts`
- Test: `bot-check/parse.spec.ts`, `pace/practice-run.spec.ts`, `commands/bot-check.spec.ts`

**Interfaces:**

- Produces: `parseIncolumitas(text: string): CheckResult` with `page: 'incolumitas'`. It passes only when the page's behavioural verdict says human. Use the exact field or wording found in Step 1, and treat a missing verdict as unparseable.
- Produces: `botCheckCommand(opts: { repeat?: number; record?: boolean }): Promise<number>`. The defaults are `repeat: 1` and `record: false`. Only the two behaviour pages repeat. A result that isn't parseable or loadable counts as `not run`, which fails the run but is shown separately from FAIL.
- Produces: `runPractice(pace: Pace, page: Page, run: number): Promise<void>` and `practiceCommand(opts: { runs: number; record: boolean })`, with default `runs: 5`.

- [ ] **Step 1: Research incolumitas.** Use the web-fetch agent on `https://bot.incolumitas.com/` to find out what interaction the behavioural classifier needs before it gives a verdict (how long, and which actions), and where the verdict appears. Write it as a comment at the top of the target. Capture the real text the same way as Task 2 Step 1 (through `bot-check`, which Claude may run), scrub it, and make the bot fixture by hand.
- [ ] **Step 2: Write failing parser tests:** `incolumitas passes on human`, `incolumitas fails on bot`, `incolumitas unparseable`.
- [ ] **Step 3: Write failing command tests**, with a fake bridge and a fake pace:
  - `repeat 3 runs the two behaviour pages three times and the first three once`;
  - `--record starts recording with source test-page and flushes to runner/`;
  - `a page that fails to load is reported as not run`.
- [ ] **Step 4: Implement.**
  - The behaviour pages' `act` uses pace: on dabi-interactions, `pace.click(email)`, `type`, `click(password)`, `type`, `pause`, `click(login)`; incolumitas follows Step 1.
  - `--record` calls `bridge.startRecording` before opening the window and writes through `createWriter({ actor: 'runner', … })`.
  - Add the targets `bot-check-repeat` (`bot-check --repeat 3 --record`) and `pace-practice` (`pace practice --runs 5 --record`).
- [ ] **Step 5: Write the failing practice-run test.** `runPractice uses every field kind once`: the fake pace sees `maybe('expand-description')`, `read`, `click(#apply)`, `glance(#email)`, `pick(#phone-country)`, `type(#phone)`, `upload(#upload)`, `type(#years)`, two `pick` calls on radios, `type(#why)`, `click(#follow)`, the `next`/`review` clicks, and `click(#submit)`. The values are made up (`fixtures/practice-answers.json`). The file is a 1-byte fixture PDF under `src/pace/fixtures/`.
- [ ] **Step 6: Implement `runPractice` and `practiceCommand`.** The order of optional actions comes from `pace.maybe`.
- [ ] **Step 7: Run tests.** Run `pnpm nx run-many -t test lint typecheck -p runner`. Expected: PASS.
- [ ] **Step 8: Live (Claude may run it).** Run `pnpm nx run runner:bot-check-repeat` and `pnpm nx run runner:pace-practice`. Expected: the table and five practice runs complete, and files appear under `pace-recordings/runner/`.
- [ ] **Step 9: Commit:** `feat(runner): pace-driven bot-check behaviour pages and practice runs`.

### Task 10: `pace compare` — GATE after the first run

**Files:**

- Create: `apps/runner/src/pace/ks.ts`, `apps/runner/src/pace/compare.ts`, `apps/runner/src/pace/fixtures/runner-leaky.json`, `runner-good.json`
- Modify: `commands/pace.ts`, `main.ts`, `package.json` (`pace-compare`)
- Test: `pace/ks.spec.ts`, `pace/compare.spec.ts`

**Interfaces:**

- Produces: `ksTwoSample(a: number[], b: number[]): { d: number; p: number }` (asymptotic p-value).
- Produces: `compare(author: Recording[], runner: Recording[], rng: Rng): CompareReport`, where:

```ts
export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}
export interface CompareReport {
  passed: boolean;
  shape: Check[];
  timing: Check[];
  variety: Check[];
}
```

- **Shape checks** (names exact):
  - `trusted`: every runner event has `trusted: true`;
  - `pointerType`: always `mouse`;
  - `coordinates`: per page, `sx - x` and `sy - y` are constant within ±1 px and match the author's offset model. That model, fitted on the author's events, gives the offset from `win` and `dpr`. Runner residuals must be within ±2 px;
  - `movement`: the share of `pointermove` events with `mx = my = 0` differs from the author's by ≤ 0.05;
  - `clickSequence`: every runner click's preceding sequence (`pointerover`? → `pointermove`+ → `pointerdown` → `mousedown` → `focusin`? → `pointerup` → `mouseup` → `click`) is one the author's events also show;
  - `wheel`: runner `dy`/`dm` values are in the author's set.
- **Timing checks:** one per measure among `sampleInterval`, `pressRelease`, `hoverToPress`, `keyHold`, `keyGapInWord`, `keyGapAfterSpace`, `wheelGap`, plus `moveDuration` normalised by Fitts index (`(duration − a) / log2(D/W+1)`). These are compared against the author's LinkedIn recordings. `stepTime` and `appTime` are compared against the author's practice recordings and the runner's practice runs only. A check passes when KS `p ≥ 0.01`. The larger sample is randomly subsampled to the smaller one's size before testing, so huge samples don't fail on trivial differences.
- **Variety:** `runsDiffer`: no two runner recordings of the same source share an identical first-50 inter-event gap sequence (rounded to 1 ms) or identical first-path points.

- [ ] **Step 1: Write failing `ks` tests:** `identical samples give d 0 and p 1`; `N(0,1) vs N(1,1) with n=500 gives p < 0.001`; `the result matches a known reference pair` (hard-code a SciPy `ks_2samp` result for two short arrays).
- [ ] **Step 2: Write failing `compare` tests** on the made-up fixtures:
  - `runner-good passes everything`;
  - `runner-leaky fails coordinates and movement` (the fixture has `sx === x` and all-zero movement);
  - `coordinate check holds at dpr 1.25 on a second monitor` (author and runner fixtures with `win.screenX = 1920` and `dpr = 1.25` pass);
  - `layout timings use the practice baseline only`;
  - `identical runs fail runsDiffer`.
- [ ] **Step 3: Implement `ks.ts`, `compare.ts`, and `pace compare`.** The command writes `pace-recordings/compare-<timestamp>.json` and a readable table, and exits 0 on pass and 2 on fail. Add the target `pace-compare`.
- [ ] **Step 4: Run tests.** Run `pnpm nx test runner -- src/pace`. Expected: PASS.
- [ ] **Step 5: First real run.** Run `pnpm nx run runner:pace-compare`.
- [ ] **Step 6: GATE.**
  - **Any shape check fails** (for example `movement` because CDP leaves `movementX/Y` at 0, or `clickSequence`): fix it inside slice 03's rules. Through Patchright's input route, an extension-side or relay-side CDP parameter is fine, but page scripts aren't. If no such fix exists, **STOP** and bring the report back to the author.
  - **Timing checks fail:** tune the pace module (bandwidths, the emitter, the Fitts fit), then re-run Task 9 Step 8 and this step.
  - Record each iteration's table in the PR notes.
- [ ] **Step 7: Commit:** `feat(runner): pace compare, runner vs author`.

### Task 11: Docs and roadmap

**Files:**

- Modify: `CLAUDE.md`, `docs/roadmap/README.md`

- [ ] **Step 1: Update `CLAUDE.md`.**
  - **Commands:** `runner:bridge-check-crash`, `pace-record`, `pace-record-typing`, `pace-summary`, `pace-build`, `pace-practice`, `pace-compare` and `bot-check-repeat`, one line each.
  - **Guardrails:** "`pace-recordings/` holds timing-only recordings and the pace profile. It is git-ignored, Claude may read it, and it is never committed."
  - **Running against LinkedIn:** "Only `apps/runner/src/pace/` may click, type, scroll or move the mouse; ESLint bans input methods elsewhere." Also: the recorder captures no text or keys, and its content script exists only while a recording command runs.
  - **The guard line:** the updated `RUNNER_SAFE_SUBCOMMANDS`.
- [ ] **Step 2: Update the roadmap.**
  - 03b's scope: recordings go to `pace-recordings/` (Claude-readable, git-ignored) instead of `private/`; the three proofs; a link to the spec.
  - Slice 06's scope gains "acts on the page only through the pace module".
- [ ] **Step 3: Commit:** `docs: slice 03b commands, pace-recordings, pace-only input`.

### Task 12: Proof and PR (author present)

- [ ] **Step 1:** Run `pnpm nx run runner:bot-check-repeat` on the day of the PR. Expected: all five pages PASS. Both behaviour pages pass all 3 repeats. A `not run` page must pass on some day before merging (spec).
- [ ] **Step 2:** Run `pnpm nx run runner:pace-practice`, then `pnpm nx run runner:pace-compare`. Expected: exit 0.
- [ ] **Step 3: The author watches.** The author watches one `pace-practice` run and one `bot-check-repeat` run. Record their verdict word for word. If they say it looks off, treat it as a fail: tune and repeat from Step 1.
- [ ] **Step 4:** Run `pnpm lint && pnpm test && pnpm typecheck && pnpm build && pnpm test:hooks`. Expected: all PASS.
- [ ] **Step 5: Push and open the PR.** Run `git push -u origin feat/slice-03b-human-pace`, then open a PR to `main` with `gh pr create`. The body holds:
  - the bot-check tables, the compare table (pass) and the compare iterations from Task 10;
  - the summary counts;
  - the author's verdict;
  - the select-picking finding (Task 8 Step 7);
  - a reminder to the author to click Reload on the extension after merging.
