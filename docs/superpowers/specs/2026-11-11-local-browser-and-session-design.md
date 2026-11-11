# Slice 03: Local browser and the LinkedIn session

Date: 2026-11-11
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 03

## Intent

The runner has to act as the author, from the browser LinkedIn already knows. That is the author's everyday Windows Chrome, with its one profile, the sign-in it has had for months, the same machine and the same home connection. The author's reasoning _(user)_: a new profile combined with new behaviour would be two unusual changes at once, so the runner builds on the existing profile and changes only who is clicking.

This slice builds only the connection to that Chrome and one command that reports whether the LinkedIn session is still signed in. It doesn't navigate jobs, fill forms or set the human-pace rules. The pace rules move to a new slice, 03b (see "Roadmap changes").

## What a spike established (2026-11-11)

Before this spec was written, a throwaway spike ran on the author's machine (Windows Chrome 157, WSL2 with mirrored networking). It ran in the author's real profile and is not part of the repo. Findings this spec rests on:

1. **Chrome refuses remote debugging on the default profile folder** (from Chrome 136, [Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)). The two ways around it are a copy of the profile or an extension using `chrome.debugger`.
2. **The extension route works.** A small unpacked MV3 extension (`debugger` and `tabs` permissions) forwarded CDP through a WebSocket relay running in WSL. Playwright-compatible `connectOverCDP` worked through it unchanged. The relay is modelled on Playwright's own `CDPRelayServer`/`BrowserModel` (in `playwright-core`, `tools/mcp/`). Windows Chrome reached the relay on `127.0.0.1` because WSL uses mirrored networking.
3. **Plain Playwright is detected, and Patchright isn't.** Results through the bridge, in the author's real profile:

   | Test page                                               | playwright-core 1.65.0                                                                                      | patchright-core 1.64.3 |
   | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- |
   | bot-detector.rebrowser.net, page load only              | `runtimeEnableLeak` caught                                                                                  | all clean              |
   | bot-detector.rebrowser.net, after `page.evaluate` calls | also `sourceUrlLeak` and `mainWorldExecution` caught                                                        | all clean              |
   | deviceandbrowserinfo.com/are_you_a_bot                  | "You are a bot!" (`isAutomatedWithCDP`, `isAutomatedWithCDPInWebWorker`, `hasInconsistentTimingResolution`) | "You are human!"       |
   | browserscan.net/bot-detection                           | normal                                                                                                      | normal                 |

   `navigator.webdriver` stayed false on both, because Chrome isn't started by automation.

4. **LinkedIn opened as signed in** through the bridge with Patchright: one load of `/feed/`, status 200, final path `/feed/foryou/`, title "Feed | LinkedIn", no sign-in form, no captcha or challenge. Nothing was clicked, and no page text, screenshot or cookie was read. LinkedIn's old global-nav selectors (`#global-nav`, `header.global-nav`) did not match.
5. **The author clicking in the run's window cut the connection** (the debugger detached mid-navigation). With the author's hands off, the same run went through.
6. **LinkedIn scans for installed extensions** (the "BrowserGate" reports, April 2026, e.g. [BleepingComputer](https://www.bleepingcomputer.com/news/security/linkedin-secretely-scans-for-6-000-plus-chrome-extensions-collects-data)). Its script tries to fetch `chrome-extension://<id>/<file>` for about 6,200 listed IDs, so an extension is visible only if its ID is on the list and it exposes `web_accessible_resources`. The same reports say LinkedIn collects about 48 device characteristics. Running in the real Chrome keeps all of them unchanged.

Not established: what LinkedIn itself checks during a session. No public source says. One clean load proves little, because platforms often act later. The author watches for LinkedIn warnings, unusual sign-in prompts or security emails in the days after the first runs.

## Goals

1. **A bridge extension in the repo** that the author loads unpacked into the everyday Chrome profile:
   - MV3 manifest with permissions `debugger` and `tabs` only. No `host_permissions`, no content scripts, no `web_accessible_resources`, and no `key` (so its ID comes from the folder path and appears on no list).
   - It attaches the debugger only to tabs it created itself, and only accepts `chrome.debugger.*` and `chrome.tabs.remove` calls for those tabs. It never touches the author's other tabs or windows. It enforces this itself, so a wrong relay can't make it do otherwise.
   - New targets open in a **new window** (`chrome.windows.create`), not a tab in the author's window.
   - It connects to the relay by itself. It tries on browser start-up and on a `chrome.alarms` timer (30 s minimum), and keeps the WebSocket alive with a ping while connected. The author never has to click its icon. The badge shows whether it is connected.
   - It authenticates to the relay with a shared secret token (Goal 3).
2. **A relay** inside the runner, listening on `127.0.0.1` only. It presents a browser-level CDP endpoint to Patchright and forwards to the extension. Port it from Playwright's relay, with these additions:
   - It requires the token on both the extension and the CDP side, and refuses a second client of either kind.
   - It refuses CDP methods that read cookies or session storage (`Network.getCookies`, `Network.getAllCookies`, `Storage.getCookies` and similar; the builder lists them) and `Browser.close`. The runner never reads cookies _(roadmap)_, and nothing may close the author's Chrome. The extension refuses the same list too, as it does for tabs it doesn't own.
   - It logs method names only, never parameters or results, because those can hold page content or cookies.
   - **What "never reads cookies" means here** _(my call)_: no runner code asks for, inspects, logs or stores a cookie. Cookie headers inside network events still pass through the relay and Patchright in memory, untouched. Stripping them would mean rewriting events and would likely break Patchright, and nothing leaves the machine either way.
3. **An install step**, `runner bridge install`. It copies the built extension to one fixed folder on the Windows side (under the author's Windows `%LOCALAPPDATA%`, found at run time, not hard-coded), so the unpacked ID stays the same. It also creates the token once and writes it both into the copied extension's config and into the runner's untracked local config. It prints the one-time steps for the author: developer mode, "Load unpacked", that folder.
4. **The runner app**, a new Nx Node CLI project named `runner`, driving Chrome through **patchright-core** at a pinned exact version. Commands this slice adds:
   - `runner bridge install` (Goal 3).
   - `runner bridge check`: starts the relay, waits for the extension, opens one window on `about:blank`, closes it, and reports connected or not. It never touches LinkedIn.
   - `runner bot-check`: opens the three public test pages from the spike in one bridge window and prints a pass/fail table. It reads results only through locators, never `page.evaluate` in the page, and never calls `exposeFunction` or `addInitScript`. Its use is to re-check after Chrome or Patchright updates. It never touches LinkedIn.
   - `runner session`: opens one window, loads `https://www.linkedin.com/feed/`, waits a short random time, classifies the page, closes the window and prints one result: `signed-in`, `signed-out`, `security-check`, `unexpected-page`, `stopped` (the connection dropped mid-run, Goal 6) or `bridge-unavailable`. Later slices reuse this set of results and the report format _(my call)_. It also writes a redacted run report to `run-reports/` with the result, the final URL path, the timings and the bridge state. No page text, no personal data, no cookies.
5. **Session classification**, in pure code tested on fixtures. It looks at the final URL path and whether a sign-in form or a challenge is present. It is not tied to one nav selector, since the spike found those had changed. Starting rules, which the builder refines on fixtures:
   - `/login`, `/uas/login`, `/authwall` or a sign-in form → `signed-out`
   - `/checkpoint/`, a captcha frame or a challenge marker → `security-check`
   - `/feed/…` with no sign-in form and no challenge → `signed-in`
   - anything else → `unexpected-page`
   - **Fixtures** _(my call)_. The author saves LinkedIn's signed-out pages (`/feed/` while signed out, which lands on the authwall or login page, and `/login`) with Ctrl+S from a Chrome guest window, into `private/`. That is ordinary human browsing from the home connection. No `curl` or other non-browser fetch of LinkedIn from the home IP, and none by Claude. The builder scrubs them into committed fixtures. The signed-in fixture and any checkpoint fixture are minimal hand-made pages built from the spike's facts and LinkedIn's public URL shapes. No capture command is built, so `runner session` never reads page content.
6. **The safety stops this slice can hit**, which are the ones later slices will reuse:
   - The debugger detaching for any reason (the author clicking or closing the run window, "Cancel" on the yellow bar, a tab crash) ends the run as stopped, with no retry.
   - A sign-in prompt or a security check ends the run with that result, with no retry.
   - `runner session` never types into the page, clicks, submits or reloads to get past anything.
7. **Guard and docs:**
   - In `.claude/hooks/guard.mjs`, set `RUNNER_NAME = 'runner'` and `RUNNER_SAFE_SUBCOMMANDS = ['bridge', 'bot-check', 'session']`, with guard tests covering launches through `pnpm nx run runner:…`, `node dist/…` and `tsx`, and covering ordinary commands that merely contain the word "runner" (for example `vitest`'s test runner, or `ls apps/runner`). If the bare word gives false positives that the guard can't avoid, pick a more distinctive name and say so in the PR.
   - `CLAUDE.md`: the stack line says Patchright (Playwright API) through the bridge extension. "Running against LinkedIn" adds that Claude may run `runner session` only when the author asks in that session, as with dry runs. `bridge check` and `bot-check` don't touch LinkedIn and need no ask.
   - The roadmap changes below are made in this slice's PR.

## Decisions

- **Patchright instead of plain Playwright** _(user, from the spike)_. This replaces the roadmap's "Playwright is the browser library". The programming interface is the same, so later slices barely notice. The version is pinned. Bumping Patchright or a Chrome update is checked with `runner bot-check`.
- **Our own bridge extension in the everyday profile** _(user, from the spike)_. Not a copied profile and not a second profile. Playwright's published "MCP Bridge" extension is not used, because it is a public Web Store tool with a well-known ID, the kind LinkedIn's scan lists.
- **Runs open their own window in the author's Chrome** _(user agreed)_. The author may keep browsing in other windows, but not in the run's window. While a run is attached, Chrome shows the "is debugging this browser" bar. LinkedIn's page can't see the bar.
- **No scripts run in LinkedIn's page.** Only the driver's normal locators and actions are used. `page.evaluate` in the page's main world, `exposeFunction` and `addInitScript` are all off-limits, because the spike showed they are what get caught. This holds for every later slice _(my call, from the spike)_. It is enforced in two places _(my call)_:
  - an ESLint rule (`no-restricted-syntax` or `no-restricted-properties`) in the runner bans `evaluate`, `evaluateHandle`, `exposeFunction`, `exposeBinding` and `addInitScript`;
  - the relay refuses `Runtime.addBinding` and `Page.addScriptToEvaluateOnNewDocument`, provided that `runner bot-check` and `runner session` still pass with them refused. If Patchright itself needs either, the builder keeps that one allowed and says so in the PR.

  Telling main-world from isolated-world `Runtime.evaluate` calls apart at the relay is not attempted.

- **The run window stays visible** _(user: "I dont mind it in this stage")_. Chrome on Windows marks a minimised or fully covered window's page as hidden and slows its timers, and a form filled on a hidden page is unusual. So the run window opens focused, at a normal size, and the author keeps it visible during runs (a second monitor, or a part of the screen not in use). The extension reports the window's state, and a minimised run window counts as a safety stop _(my call)_. Full covering can't be detected, so it is the author's job. Phase 2 (unattended runs) revisits this.
- **Human-pace rules are not in this slice** _(user: "Split it into 03b")_. `runner session` is a single page load, which needs no pace rules beyond a short random wait before closing.
- **The relay runs in WSL, Chrome on Windows** _(roadmap, my call)_. This depends on WSL mirrored networking, which the author has. `runner bridge check` says plainly when the extension can't reach the relay.
- **A token between the extension and the relay** _(my call)_. Without one, any local program could reach the author's LinkedIn session through the relay.
- **The spike's leftovers get removed.** The author removes the spike extension from Chrome and deletes `C:\Users\proup\10xapply-spike` before loading the real one. The builder reminds them in the PR.

## Roadmap changes (made in this slice's PR)

- **Locked decisions:** replace "Playwright is the browser library" with Patchright (Playwright API) through our own bridge extension in the everyday profile. Replace the "Two things for slice 03 to settle" bullets with what was settled, and point to this spec.
- **New slice 03b: Human pace from the author's own applications**, which depends on 03. Scope:
  - A recorder in the bridge extension, switched on by the author. It records only timings: page load, scroll, dwell on the description, mouse path and speed, gaps between keystrokes, time per form step, and time from opening the form to Submit. It never records what is typed, which keys, or page text. It listens from an isolated content-script world and changes nothing on the page. Recordings go to `private/`.
  - The author applies to 5–10 jobs by hand with it on.
  - The pace module all later slices use, built from those ranges _(user: "should look human, but also, should be random, not repeatable / robotic")_:
    - every delay drawn fresh from the recorded ranges, with occasional long pauses;
    - a per-run "mood" that shifts the overall pace;
    - reading time that scales with the length of the description, plus noise;
    - action order and optional actions (scrolling the description or not) that vary;
    - curved mouse paths with slight overshoot, never jumping onto a button;
    - typing with per-key timing from the recordings;
    - fresh randomness every run, never a fixed seed;
    - no fake typos, because a typo left on a form would be a wrong answer.
  - It is checked against deviceandbrowserinfo's behaviour test.
  - Spec answers: whether adding a content script changes the extension's visibility (it adds no `web_accessible_resources`, so the reported probe still can't see it); how ranges are stored; how many recordings are enough.
- **Slice 06 depends on 03, 03b and 05.** The Phase 1 table and the dependency note ("03 and 04–05 are independent") are updated to match.

## Non-goals

- Opening jobs, reading or filling forms, or submitting (slices 06 and 07).
- Human-pace rules and the recorder (slice 03b).
- Starting the relay and the extension at Windows log-in, or any unattended running (slice 14).
- Hosted browsers, profiles or proxies (Phase 3).
- Any Chrome launch flags, automation of the profile folder, or a copy of the profile.

## Anti-goals

- The author's LinkedIn account is flagged, restricted or asked to verify because of this slice.
- The runner reads, logs or stores a cookie, or anything leaves the machine except the page loads themselves.
- The extension touches a tab or window it didn't create.
- The extension is visible to LinkedIn's extension scan, or changes anything in LinkedIn's pages.
- A run retries, reloads or clicks its way past a sign-in prompt or a security check.
- Claude starts `runner session` without the author asking in that session.

## Left to the builder

- Project layout: the extension as its own Nx project (for example `apps/bridge-extension`) or a folder inside `apps/runner`, and how the build hands it to `runner bridge install`.
- The relay's exact port and how it is configured, and where the runner's local config with the token lives (an untracked `.env*` file or a file under `private/`), following the repo's guardrails.
- How the extension finds the token (a generated config file in the installed folder is fine).
- The exact list of refused CDP methods.
- Test design: unit tests for the relay with a fake extension and a fake CDP client (including token checks, refused methods, and refusing tabs the extension doesn't own), and fixture tests for classification. Real-Chrome checks (`bridge check`, `bot-check`, `session`) are run by hand and reported in the PR. The author runs `session`, or Claude runs it when the author asks.
- The waits and timeouts inside `runner session`, within "one page load, short random wait, close".
