# Slice 03b: Human pace from the author's own applications

Date: 2026-11-11
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 03b. Builds on [slice 03](2026-11-11-local-browser-and-session-design.md).

## Intent

From slice 06 on, the runner moves the mouse, scrolls, clicks and types in the author's everyday Chrome, on LinkedIn. How it does that is one of the main things LinkedIn can watch. This slice makes the runner act the way the author does, and makes each run different from the last. The author's words: it "should look human, but also, should be random, not repeatable / robotic".

The pace isn't invented. The author applies to 5–10 jobs by hand with a recorder on, and the pace module is built from those recordings. Before the runner goes near a real Easy Apply form, the slice proves the pace three ways: public behaviour-test pages, our own comparison of the runner against the recordings, and the author watching it.

This slice never drives LinkedIn. The recorder only listens while the author browses by hand. Every runner check happens on public test pages or on a local practice page.

## How the author applies today _(user)_

This is the behaviour the pace module copies:

- The author opens the job, clicks "more" to expand the description, scrolls down and reads for about 5 seconds.
- They click Apply with the mouse and fill the Easy Apply form.
- **Mouse only.** They move between fields by clicking, never with Tab.
- Some fields come prefilled, because LinkedIn remembers answers given before, and the author types into a few others. How much typing that comes to is measured from the recordings, not guessed _(user: "try and see")_.
- One application takes about 2 minutes.

## Goals

### 1. Leak check first

Before anything else is built, find out whether synthetic mouse input through the bridge gives itself away.

- Add `https://deviceandbrowserinfo.com/are_you_a_bot_interactions` to `runner bot-check` as a fourth page. The runner fills its fake login form (an obviously fake email and password, never real ones) and clicks Login. Results are read through locators only, as for the other pages.
- The flags that matter are `suspiciousClientSideBehavior`, `superHumanSpeed` and `hasCDPMouseLeak`. `hasCDPMouseLeak` means the mouse coordinates don't add up: the position on screen doesn't match the window's position plus the position on the page. That's a known giveaway of CDP `Input.dispatchMouseEvent`.
- The first run uses plain Patchright mouse calls, before any pace work exists, to see whether the leak fires at all.
- **If `hasCDPMouseLeak` fires,** fixing it comes before the rest of the slice. If no fix is found that keeps slice 03's rules (no scripts in the page, nothing the extension scan can see), the builder stops and brings it back to the author. This can't be worked around with pace; every click would carry the giveaway.
- While doing this, check whether the relay's faked `Browser.getVersion` reply (a slice 03 follow-up) is visible to any of the test pages. If it is, fix it in this slice.

### 2. The recorder

A recorder inside the bridge extension that captures how the author moves, never what they see or type.

- **It's off unless a recording command is running** _(my call)_. `runner pace record` starts the relay and tells the extension to start recording. Only then does the extension register its content script (through `chrome.scripting.registerContentScripts`); it unregisters it when the command stops or the connection drops. So everyday browsing is never recorded, and the content script isn't even present outside a sitting. The badge shows when recording is on.
- **Where it listens:** LinkedIn job and Easy Apply pages only (`https://www.linkedin.com/jobs/*`, including the Easy Apply dialog on those pages). It also listens on the test pages and the practice page from Goal 5, so the author's practice-page sitting and the runner can be recorded with the same code.
- **How it listens:** a content script in the extension's isolated world, using passive listeners only. It never changes the DOM, never calls `preventDefault`, never injects into the main world. The manifest still has no `web_accessible_resources`, so LinkedIn's extension probe still can't see it.
- **What it captures, per event:** a timestamp; the event type (pointer, mouse, wheel, key, focus, scroll, click); `isTrusted`; client and screen coordinates; button; wheel `deltaY` and `deltaMode`; `pointerType`; `movementX/Y`; and a coarse **target kind** (tag, role, input type: for example "button", "text input", "select", "radio", "file input"). For key events it captures the timing (keydown and keyup times) and one class: space, backspace, or other key. It never captures `key` or `code` beyond that class. Window size, screen size and window position are captured once per recording, so coordinates can be checked.
- **Facts derived from the page, allowed** _(user: "can note everything that can be noted")_:
  - whether a key was a space, so gaps within and between words can differ, and backspace, so corrections the author makes are visible in the timing;
  - how long the job description is, as a number (characters and rendered height), recorded once per page;
  - whether a field already had a value when it got focus, as yes or no;
  - for a select, radio group or checkbox list, how many options there were and the index of the one picked, never the option's label.

  Anything else of this kind, a number or a yes/no that holds no text, is fine for the builder to add. My call on where the line is: "everything" stops at text and actual keys. The recordings are Claude-readable, and typed answers are personal facts that belong only in `private/`.

- **What it never captures:** typed text, which keys were pressed, page text, labels, URLs beyond the path pattern (for example `/jobs/view/<id>` becomes `/jobs/view/:id`), element ids or classes, cookies or storage.
- **Phases.** Each event is tagged with a coarse phase so the profile can tell reading from filling: `job-page`, `description` (after "more" is expanded, or while scrolling the description), `easy-apply-step` (with the step number), `review`, `submitted`. Phases are worked out from the path, the presence of a dialog, and target kinds, never from text. The exact rules are the builder's, refined on the author's first recording.
- **Where it goes:** the extension sends events to the relay over the existing WebSocket. The runner writes one file per application to `pace-recordings/` at the repo root. This folder is git-ignored and Claude-readable _(user: "I give you the right to read")_, like `run-reports/`. It is never committed. This replaces the roadmap's "Recordings go to `private/`".
- `runner pace record` prints a running count (applications, clicks, keystroke gaps, scrolls) and stops cleanly on Ctrl+C.

### 3. The author's sitting

- The author runs `runner pace record` and applies by hand to 5–10 jobs, the way they normally do.
- **Real applications, sent by the author by hand.** This is ordinary use of LinkedIn. Nothing is automated during the sitting.
- `runner pace summary` reads `pace-recordings/` and prints how much data there is per thing the pace module needs (description reads, "more" clicks, mouse paths to buttons, field-to-field moves, typed fields and keystroke gaps, form steps, whole applications). Next to each count it shows the minimum needed and says "enough" or "short". The builder sets the minimums, with the reasoning in the plan.
- **If typing is short** _(my call)_, `runner pace record --typing` opens a local page served by the runner with a few text boxes. The author types anything there (it's never kept, and the recorder still records only gaps). It runs until the summary says "enough".
- **The author also fills the practice page** _(user agreed)_. The practice page is described in Goal 5. With `runner pace record` on, the author fills it by hand 3–4 times, taking about 10 minutes. That gives a like-for-like baseline for the runner on the same layout. These recordings are kept apart from the LinkedIn ones, which the profile is built from.

### 4. The pace profile and the pace module

- **The profile.** `runner pace build` turns the recordings into one profile file in `pace-recordings/`: distributions (not just min–max ranges) for each timing, path shape parameters, scroll notch size and rhythm, mouse sampling interval, press-to-release gaps, keystroke gaps (within a word, between words), dwell per field kind, time per step, whole-application time, and how much these shift from one application to the next. The format is the builder's (JSON is fine). The profile is git-ignored too. Tests use a small made-up profile committed as a fixture.
- **The pace module,** in `apps/runner/src/pace/`, is what every later slice uses to touch a page. It offers the actions slices 06 and 07 need: move to an element and click it, scroll an area, read (dwell) for a length of text, type into a field, pick an option, move on to the next step. It works on top of Patchright's `page.mouse` and `page.keyboard`. Its rules _(user, from the roadmap)_:
  - every delay is drawn fresh from the profile's distributions, with occasional long pauses;
  - a per-run "mood" shifts the overall pace, drawn from how much the author's own applications differ from each other;
  - reading time scales with the length of the text, plus noise, fitted to the author's own numbers (about 5 s for a normal description, so a long one gets a bit more, not minutes);
  - action order and optional actions vary (clicking "more" or not, scrolling the description or not, small idle mouse moves), at the rates seen in the recordings;
  - mouse paths are curved, with slight overshoot and the author's speed profile, and never jump onto a target. The point clicked inside an element varies;
  - moving between fields is a mouse move and a click, never Tab _(user: mouse only)_;
  - scrolling uses wheel notches with the author's rhythm, not smooth or instant scrolls;
  - typing uses per-key gaps from the profile;
  - prefilled fields get a check-and-move-on pass (a short dwell, no typing), as seen in the recordings;
  - randomness is fresh every run and there is never a fixed seed in the runner. Tests may inject a seeded random source;
  - no fake typos, because a typo left on a form would be a wrong answer.
- **Only the pace module touches the page** _(my call)_. An ESLint rule in `apps/runner` bans `click`, `dblclick`, `fill`, `type`, `press`, `pressSequentially`, `check`, `uncheck`, `selectOption`, `setInputFiles`, `hover`, `tap`, `dragTo` and `mouse.*` / `keyboard.*` outside `src/pace/`. Locators are used only to find elements and read them. A locator's own `click()` would jump straight to the element, which is exactly what this slice prevents. If Patchright has no input route for something (file upload is the likely case), the pace module wraps it, does the human part around it (moving to and clicking the upload button) and says so.

### 5. Proof

All three checks are in _(user: "all three")_.

1. **Two behaviour test pages.** `runner bot-check` runs deviceandbrowserinfo's interactions page (Goal 1) and `bot.incolumitas.com`'s behavioural classification, both driven by the pace module. Each page passes several runs in a row (the builder picks how many, at least 3). On deviceandbrowserinfo that means `suspiciousClientSideBehavior`, `superHumanSpeed` and `hasCDPMouseLeak` all false; on incolumitas it means its behavioural verdict says human. The table shows each flag. The first three pages from slice 03 must still pass.
2. **The recorder as our own detector.** The runner is recorded by the same recorder while it works through:
   - the two test pages, and
   - **a local practice page** _(my call)_: a hand-made multi-step form served by the runner on `127.0.0.1`, with no LinkedIn content, that has the field kinds Easy Apply uses (text, number, select, radio, checkbox, file upload, Next/Review/Submit buttons, one prefilled field, a long description with a "more" button). It lets the comparison cover a whole application, not just a login form.

   `runner pace compare` puts the runner's recordings next to the author's and writes a report to `pace-recordings/`. It passes when:
   - **event shape matches:** the same event sequences around a click (pointer and mouse events before it, the hover, the press-to-release gap), `isTrusted` true everywhere, coordinates that add up, wheel notches the size the author's mouse sends, mouse sampling at the author's rate;
   - **comparisons are like for like:** layout-dependent timings (time to reach a target, time per step, whole-form time) are compared only against the author's practice-page recordings. Everything else (press-to-release time, keystroke gaps, scroll rhythm, mouse speed scaled for distance and target size) is compared against the author's LinkedIn recordings;
   - **timings match statistically,** not just "inside the range": each timing's distribution is compared with a two-sample test (the builder picks the test, the threshold and the number of runner runs, and writes the reasoning in the plan);
   - **runs differ:** no two runner runs have the same timings or paths.

3. **The author watches it.** The author watches the runner do the practice page and the test pages. If anything looks off to them (jumpy, too even, too fast), it's a fail, even when the numbers pass. The PR records the author's verdict.

**All three must pass before the PR merges** _(my call)_. Two more rules:

- **Event-shape giveaways get the same treatment as the mouse leak** _(my call)_. If `compare` finds one, such as `movementX/Y` always 0 or pointer and mouse events in the wrong order around a click, it gets fixed in this slice. If no fix fits slice 03's rules, the builder stops and brings it back to the author. The plan puts a gate right after the first `compare` run.
- **If a test page is down, changed, or gives no clear verdict** _(my call)_, `bot-check` reports it as "not run", not as a pass. The PR can't merge until each page has passed on some day. If a page is gone for good, the builder brings it back to the author rather than swapping in another one. The builder finds out what interaction incolumitas needs before it gives a verdict, and writes that in the plan.
- **How the runner gets recorded** _(my call)_: `bot-check` and the practice-page run take a `--record` flag. That flag turns the recorder on inside the same runner process and relay, so the relay never has to take two clients at once.

### 6. Slice 03 follow-ups folded in _(my call)_

- The flaky runner test: the `sleep(50)` waits in `apps/runner/src/bridge/bridge.spec.ts` are replaced by waiting for the actual event.
- The crash stop: slice 03 never verified it, because new pages get no `Inspector.enable`. Make sure a tab crash really ends a run as `stopped`, and test it.
- The faked `Browser.getVersion`: see Goal 1.

The session report's `startedAt` and `loadMs` naming is left for a later slice; 03b doesn't touch that code.

### 7. Guard, docs and roadmap

- `.gitignore` adds `pace-recordings/`. The guard leaves it readable.
- `RUNNER_SAFE_SUBCOMMANDS` adds `pace`. `pace record` only listens while the author browses by hand and never drives LinkedIn. `pace summary`, `build` and `compare` only read files. The practice page and test pages never touch LinkedIn. So Claude may run all of them without asking. Guard tests cover the new subcommand.
- `CLAUDE.md`: commands for `runner:pace-record`, `pace-summary`, `pace-build`, `pace-compare` (or whatever Nx target names the builder picks), `pace-recordings/` under Guardrails, and the rule that only the pace module touches the page under "Running against LinkedIn".
- Roadmap: 03b's scope says recordings go to `pace-recordings/` (Claude-readable, git-ignored) instead of `private/`, and lists the three proofs. Slice 06's scope says it acts through the pace module only.

## Non-goals

- Driving LinkedIn in any way. The runner's first LinkedIn actions are slice 06's dry runs.
- Reading, answering or filling real Easy Apply forms (slices 05 and 06).
- Pacing _between_ applications, daily caps and quiet hours (slice 14). This slice paces actions inside one application.
- Keyboard navigation (Tab, Enter to submit), because the author doesn't use it.
- Fake typos and corrections.
- Recording anything outside a `runner pace record` session.

## Anti-goals

- The recorder captures typed text, which keys were pressed, page text, or cookies, or records everyday browsing.
- The recorder changes anything in LinkedIn's page, or makes the extension visible to LinkedIn's extension scan.
- The runner clicks without moving there first, moves in straight lines at a steady speed, or repeats the same timings from run to run.
- Pace work is built on top of a mouse leak that would give away every click.
- Recordings or the profile get committed.
- Claude starts anything in this slice that drives LinkedIn.

## Left to the builder

- The phase rules, refined on the first recording.
- The minimum counts in `pace summary`, the statistical test, its threshold, and how many runner runs `compare` uses.
- The path model (Bézier, minimum-jerk or similar) and how its parameters are fitted, as long as the comparison passes.
- The recording and profile file formats.
- The practice page's exact layout, within the field kinds listed.
- How a leak fix works, within slice 03's rules, or stopping and asking if none fits.
- Nx target names for the new commands.
