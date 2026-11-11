# Roadmap

Date: 2026-11-10
Status: draft

## Intent

10xapply applies to LinkedIn jobs from a user's own LinkedIn account. The first thing that has to work is one real Easy Apply application, submitted from the author's account and filled correctly from the author's facts _(user)_. Everything else is ordered around reaching that early, then turning it into a steady stream of applications for the author, and only after that opening it to friends.

The top risk is still a LinkedIn restriction or ban (see `CLAUDE.md`). The order below keeps the risk low early on. Until Phase 3 the browser runs only on the author's own machine, from their home connection, in the author's everyday Chrome that LinkedIn already knows. That is the least unusual setup LinkedIn can see. Servers, proxies and hosted sessions come only once the rest works.

## How this roadmap works

Each slice is sized for one session: brainstorm, spec in `docs/superpowers/specs/`, plan in `docs/superpowers/plans/`, then a branch and a PR to `main`. Each slice below gives its scope, the decisions already locked, and the questions its own spec must answer. Locked decisions are not reopened in a slice spec unless something new comes up. Phases 3 and later are headlines only. Each gets its own roadmap session, with the same layout as 10xjobs's `docs/roadmap/phase-*` folders, before its first slice starts.

Decision marks: _(user)_ means the user decided it; _(my call)_ means Claude proposed it and the user accepted the roadmap without discussing that point. A slice spec may revisit a _(my call)_ when it has a reason.

## Phases at a glance

| Phase | Name                             | Where the browser runs                | Who uses it      |
| ----- | -------------------------------- | ------------------------------------- | ---------------- |
| 0     | Foundation                       | (none)                                | (none)           |
| 1     | First real application           | Author's machine, hand-triggered      | Author           |
| 2     | Steady stream for the author     | Author's machine, takes approved jobs | Author           |
| 3     | Friends                          | Our servers, residential IP per user  | Author + friends |
| 4     | External jobs posted on LinkedIn | Our servers                           | Same             |
| Later | Other channels (Indeed etc.)     | Our servers                           | Same             |

## Decisions locked for the whole roadmap

- **Easy Apply only until Phase 4** _(user)_. Phases 1–3 handle only LinkedIn's Easy Apply form. Jobs that send the applicant to a company site come in Phase 4. Other job boards come after that.
- **Auto-submit unless something blocks** _(user)_. When every answer on the form is backed by the facts with confidence, the run submits without waiting. It stops and asks only when a question blocks it. This holds from the first application on.
- **Author's machine first, servers later** _(user)_. In Phases 1 and 2 the browser runs on the author's own computer, from their home connection. Applications only happen while that computer is on and the runner is running, which is accepted for Phase 2 _(user)_.
- **Stream for the author before friends** _(user)_. Phase 2 (webhook intake, approval, unattended runs for one user) comes before Phase 3 (hosted browsers for several users).
- **Build infrastructure only when a slice needs it** _(my call)_. Supabase, the web app and the hosted API enter in Phase 2, when the stream needs them, not in Phase 0.
- **Redis waits until Phase 3** _(my call)_. In Phase 2 a single local runner reads approved jobs from Postgres. Redis queues arrive with hosted workers, when several accounts run on our servers.
- **Mirror 10xjobs wherever it already decided** _(user, from the original brief)_. That covers the Claude harness, CI, the Prisma contract as the only schema source (RLS included), the Supabase CLI locally and Supabase Cloud hosted, Next.js on Vercel, NestJS on a Hetzner server with Docker Compose and Caddy, deploys on merge, and LLMs through OpenRouter with the model per role set in configuration. Paths to copy from are named in each slice.
- **Who may run things against the real LinkedIn account, widening over time** _(user wants Claude to run everything eventually; the stages are my call)_. The risk to the account comes from how often and how fast the account is used. Who starts a run matters less. So Claude's access widens as the runner's own limits are built:
  - **Phases 0–1:** Claude may run `--dry-run` only, against at most a small number of jobs a day, and only when the author asked for it in that session. Real submits are run by the author. Run reports go under `private/` but also have a redacted copy (no personal facts, no cookies) in a git-ignored, Claude-readable folder so Claude can debug from them. Saved page snapshots are committed as test fixtures only after being scrubbed of personal data.
  - **From slice 14:** once the runner itself enforces pacing, the daily cap and the safety stops, Claude may start the runner, real submits included, because every run goes through those limits whoever started it.
  - Slice 01's guard enforces the first stage. Slice 14 relaxes it.
- **Author's everyday Chrome first, a dedicated profile before servers** _(user)_. Through Phases 1 and 2 the runner uses the author's normal Windows Chrome and the LinkedIn sign-in it already has. The switch to a dedicated profile comes with the move to servers in Phase 3. Slice 03 settled two things (see [its spec](../superpowers/specs/2026-11-11-local-browser-and-session-design.md)):
  - Recent Chrome versions refuse automation (remote debugging) on the default profile folder. Slice 03 uses our own small bridge extension in the everyday profile, not a copy of the profile or a second profile.
  - The browser is Windows Chrome, not Chrome inside WSL, so LinkedIn sees the same device as always _(my call)_. The relay runs in WSL and the extension reaches it over WSL's mirrored networking.
- **One fixed resume now, tailored resumes soon** _(user)_. Phases 1–2 upload one fixed resume. Tailored per-job resumes come right after Phase 2's launch check (slice 17), reusing the author's existing resume engine from its own repo. Slice 12's webhook payload leaves room for a per-job resume reference.
- **Safety stops apply from Phase 1 on.** Every run stops, without submitting, on a captcha, a security check, a sign-in prompt, an unfamiliar field type or an unexpected page. No run retries its way past one of these.

## Phase 0: Foundation

The Claude harness and CI. No product code.

**Exit criteria:** the guard hook blocks reads and writes of `.env*` and `private/` and every push form except `git push -u origin <branch>`, and its tests pass. Every PR runs lint, test, build and typecheck in GitHub Actions.

| #   | Slice          | Depends on |
| --- | -------------- | ---------- |
| 01  | Claude harness | none       |
| 02  | Tooling and CI | 01         |

### 01 Claude harness

- **Scope:** `.claude/hooks/guard.mjs` with its tests, `.claude/hooks/format.mjs` (Prettier on edited files), permissions and hooks in `.claude/settings.json` (keeping the existing Nx plugin entries), and a `test:hooks` script. The guardrails and commands sections of `CLAUDE.md` are updated to match.
- **Copy from:** `/home/lab/apps/10xjobs/.claude/` (`settings.json`, `hooks/guard.mjs`, `hooks/format.mjs`, `hooks/guard.test.mjs`).
- **Locked:** same rules as 10xjobs. Only `git push -u origin <branch>` and `gh pr create` to `main` are allowed, and the human merges.
- **Also:** rules for runner commands so Claude can start only `--dry-run` runs (see "Who may run things against the real LinkedIn account"), and the git-ignored, Claude-readable folder for redacted run reports.
- **Spec answers:** how the guard recognises a runner command that isn't a dry run (runner app name is chosen in slice 03, so the rule may land there instead); anything in 10xjobs's guard that is 10xjobs-specific and should be dropped.

### 02 Tooling and CI

- **Scope:** ESLint, Vitest and Prettier check set up through Nx; `.github/workflows/ci.yml` running `nx run-many -t lint test build typecheck` (or `affected`) on PRs to `main`.
- **Copy from:** `/home/lab/apps/10xjobs/.github/workflows/ci.yml`, `eslint.config.mjs`, `vitest.config.mts`.
- **Spec answers:** whether CI also runs `test:hooks`; whether to turn on branch protection requiring CI on `main`.

## Phase 1: First real application

The author gives the runner one LinkedIn job URL. A real Chrome window on the author's machine, signed in by the author, opens the job, fills the Easy Apply form from the author's facts, submits it when every answer is confident, and remembers the job so it never applies twice. No database, no web app, no server.

**Exit criteria:** from a terminal command with one job URL, a real Easy Apply application is submitted from the author's account with every answer correct and none invented. A question the facts can't answer stops the run and asks in the terminal. A second command on the same job refuses to apply. Each safety stop (captcha, security check, signed out, unfamiliar field) ends the run without submitting.

| #   | Slice                                         | Depends on  |
| --- | --------------------------------------------- | ----------- |
| 03  | Local browser and the LinkedIn session        | 02          |
| 03b | Human pace from the author's own applications | 03          |
| 04  | Fact bank file                                | 02          |
| 05  | Answering form questions                      | 04          |
| 06  | Walk the form without submitting              | 03, 03b, 05 |
| 07  | Submit, and never twice                       | 06          |

03→03b and 04→05 are independent of each other and can be built in either order.

### 03 Local browser and the LinkedIn session

- **Scope:** the first Nx app, a Node CLI runner (name decided in the spec). It drives the author's everyday Windows Chrome, already signed in to LinkedIn, from the WSL workspace. One command checks whether the session is still signed in. The runner never types a password and never reads or logs cookies.
- **Locked:** Patchright (Playwright API) is the browser library, through our own bridge extension in the everyday profile (from `CLAUDE.md`). The author's everyday Chrome on Windows, not a Chrome inside WSL _(user, Windows is my call)_. The browser runs headed on the author's machine, on the home connection, with no proxy.
- **Spec answers:** settled in the [slice 03 spec](../superpowers/specs/2026-11-11-local-browser-and-session-design.md). The runner attaches through our own bridge extension (`chrome.debugger`) in the everyday profile, because Chrome refuses remote debugging on the default profile folder, and each run opens its own window, never the one the author is browsing in. Plain Playwright's CDP use is caught by public bot-check pages and Patchright's is not, so Patchright is pinned and `runner bot-check` checks it after a bump or a Chrome update. "Signed out" and "security check" are recognised from the final page path and a few locators. The human-pace rules moved to slice 03b.

### 03b Human pace from the author's own applications

- **Scope:**
  - A recorder in the bridge extension, switched on by the author. It records only timings: page load, scroll, dwell on the description, mouse path and speed, gaps between keystrokes, time per form step, and time from opening the form to Submit. It never records what is typed, which keys, or page text. It listens from an isolated content-script world and changes nothing on the page. Recordings go to `pace-recordings/` (Claude-readable, git-ignored), not `private/`.
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
  - It is proved three ways: public behaviour-test pages (deviceandbrowserinfo and incolumitas, several runs in a row), `runner pace compare` of the runner against the author's recordings, and the author watching it.
  - Only the pace module acts on a page; ESLint bans input methods elsewhere.
- **Spec:** [slice 03b spec](../superpowers/specs/2026-11-11-human-pace-design.md).
- **Spec answers:** whether adding a content script changes the extension's visibility (it adds no `web_accessible_resources`, so the reported probe still can't see it); how ranges are stored; how many recordings are enough.

### 04 Fact bank file

- **Scope:** the author's facts in a file under `private/` (contact details, the one fixed resume's PDF path, work authorization, location, years of experience, skills, salary expectations, notice period, languages, links, and stock answers such as "why this company" stances), with a checked schema and a typed loader. A committed example file with fake data shows the format.
- **Locked:** real facts never leave `private/` and are never committed. The schema is designed to move into Postgres in slice 10 without being reshaped.
- **Spec answers:** the fact list and format (JSON, YAML or Markdown with structure); whether facts carry their own notes (for example, "only answer yes to relocation for Europe").

### 05 Answering form questions

- **Scope:** given one form question (label, field type, options, required or not, any help text) and the facts, return an answer with a confidence level and the fact or facts it rests on, or say it can't answer. Calls go through OpenRouter. A golden set of real Easy Apply questions with expected answers, and an eval command, like 10xjobs's `processor:eval`. No browser.
- **Locked:** never invent. An answer not supported by the facts counts as "can't answer", which becomes a blocking question. Simple fields (name, email, phone, resume upload) are filled straight from the facts without an LLM where possible _(my call)_.
- **Spec answers:** the confidence rule that decides "auto-submit" versus "blocking" (this is what protects the "wrong or invented answer" anti-goal); which model; how numeric and select fields are matched to options; how the golden set is gathered without committing personal data (it may live in `private/`).
- **Copy from:** 10xjobs's OpenRouter client and eval setup in `apps/xjobs`.

### 06 Walk the form without submitting

- **Scope:** `apply <job-url> --dry-run`: open the job, confirm it is Easy Apply and not already applied to, open the form, read each step's questions into a structured list, answer them through slice 05, fill them in, move through the steps and stop on the review page before Submit. It acts on the page only through the pace module. Print and save (under `private/`) a run report: each question, the answer, its confidence and source.
- **Locked:** the safety stops listed at the top. Only Easy Apply; any other kind of job is reported and skipped.
- **Spec answers:** which field types are supported at first and how an unknown one is detected; how the runner recognises each step and the review page; how many dry runs on real jobs are enough before slice 07 turns on submit.

### 07 Submit, and never twice

- **Scope:** `apply <job-url>` without `--dry-run`. If every answer is confident, it submits. If something blocks, it asks the author in the terminal, then continues or stops. After submitting, it confirms LinkedIn shows the job as applied. A local record of applied jobs under `private/`, keyed on the LinkedIn job id, refuses a second application. LinkedIn's own "Applied" marker is checked too.
- **Locked:** auto-submit unless blocked _(user)_. The local record is written before the Submit click, as "submitting", and updated after it, so a crash mid-submit never leads to a second attempt without the author checking.
- **Spec answers:** whether a terminal answer is saved back into the fact bank for next time; what happens if the browser crashes mid-run; the format of the local record (it moves to Postgres in slice 14).

## Phase 2: Steady stream for the author

10xjobs sends its matches for the author to 10xapply. The author approves or skips each one in the web app. The runner on the author's machine works through approved jobs on its own, at a human pace and within a daily cap, while the machine is on. Blocking questions show up in the web app. Only parts that hold no LinkedIn session run hosted: the API and the database.

**Exit criteria:** a job 10xjobs matches for the author shows up in the web app; approving it leads to a submitted Easy Apply application by the runner without any terminal command; a blocking question can be answered in the web app and the run then goes ahead; the same job sent twice by webhook, or approved twice, is applied to at most once; matches for an email with no account are held and show up when that person signs up; one user can never read another user's data, and tests prove it.

| #   | Slice                             | Depends on |
| --- | --------------------------------- | ---------- |
| 08  | Supabase and the database         | 02         |
| 09  | Web app and invite-only sign-in   | 08         |
| 10  | Facts in the database             | 09, 04     |
| 11  | Hosted API                        | 08         |
| 12  | Webhook intake                    | 11         |
| 13  | Approve or skip matches           | 09, 12     |
| 14  | The runner takes approved jobs    | 07, 10, 13 |
| 15  | Blocking questions in the web app | 14         |
| 16  | Launch check                      | 08–15      |
| 17  | Tailored resumes                  | 16         |

10 and 11–12 are independent and can be built in either order.

### 08 Supabase and the database

- **Scope:** a shared database library with the Prisma contract as the only schema source (RLS policies included), the local Supabase CLI stack, a Supabase Cloud dev project, migrate and seed scripts with the remote-database guard, and RLS tests.
- **Copy from:** 10xjobs `libs/database`, `supabase/`, `apps/db-tests`, and specs `2026-11-03-accounts-and-isolation`, `2026-11-05-shared-dev-database`.
- **Locked:** every row a user owns carries `userId` and is isolated by RLS; engine-only tables have RLS on with no policies. Separate Supabase project from 10xjobs (from `CLAUDE.md`).

### 09 Web app and invite-only sign-in

- **Scope:** Next.js app on Vercel, invite-only Supabase Auth sign-in, an empty signed-in home page, the design system copied from 10xjobs.
- **Copy from:** 10xjobs `apps/web`, `apps/web/DESIGN.md`, specs `2026-11-03-invite-only-sign-in`, `2026-11-08-design-system`.

### 10 Facts in the database

- **Scope:** the fact bank moves from the `private/` file into Postgres, with the resume in Supabase Storage. The author views and edits facts in the web app. The runner reads facts from the database, and a one-off import moves the author's existing file in.
- **Copy from:** 10xjobs spec `2026-11-06-resume-storage`.
- **Spec answers:** whether stock answers learned from blocking questions are their own list or plain facts.

### 11 Hosted API

- **Scope:** the NestJS API app, a Hetzner server running Docker Compose with Caddy for HTTPS, deploy on merge to `main` through GitHub Actions, secrets only on the server and in GitHub secrets.
- **Copy from:** 10xjobs specs and plans `2026-11-10-engine-hosting`, `deploy/`, `docker-compose.yaml`, `.github/workflows/deploy-engine.yml`.
- **Spec answers:** whether 10xapply shares 10xjobs's server or gets its own. `CLAUDE.md` says separate servers; the spec confirms that holds even for a tiny API.

### 12 Webhook intake

- **Scope:** the webhook endpoint and the payload contract 10xapply defines (user email plus the job: LinkedIn job id, URL, title, company, location, Easy Apply flag if known), with room for an optional per-job resume reference that slice 17 fills. Signature check against the single integration API key, idempotent on the job, held matches for unknown emails attached when that person signs up. The sending side in 10xjobs is a separate small PR in the 10xjobs repo, specced here and built there.
- **Locked:** everything in `CLAUDE.md` under "Webhooks".
- **Spec answers:** the signing scheme and key rotation; whether idempotency is per job or per user and job (one job can match several users); what happens to a held match that is never claimed; when 10xjobs sends (on match, or in a batch).

### 13 Approve or skip matches

- **Scope:** a web app list of incoming matches with the job's details and a link to the posting; approve or skip each. Approving sets the match to "approved", which is what the runner picks up. Jobs that aren't Easy Apply are shown but can't be approved yet.
- **Locked:** nothing is applied to without the author's approval (from `CLAUDE.md`).
- **Spec answers:** whether approval can be undone before the run starts; how Easy Apply is detected if the webhook doesn't say.

### 14 The runner takes approved jobs

- **Scope:** the local runner from Phase 1 runs as a long-lived process on the author's machine. It picks up approved jobs from Postgres one at a time, applies at a human pace with gaps between applications, respects a daily cap and quiet hours, and writes each run's status and report back to the database. The Phase 1 local record of applied jobs moves into Postgres, with a unique constraint on user and job.
- **Locked:** one run at a time per account; daily cap; stop on the safety stops, and a stop pauses the whole runner until the author looks, not only that job _(my call)_. From this slice on, Claude may start the runner, real submits included; the guard is relaxed here.
- **Spec answers:** how the runner authenticates to the database from the author's machine (a scoped key or the author's own session; not the service role key unless justified); the cap, gaps and hours as configuration with starting values; how a run left in "submitting" after a crash is resolved.

### 15 Blocking questions in the web app

- **Scope:** when a run blocks, its question shows in the web app. The author answers, the answer is saved to the facts, and the job goes back to approved so the runner tries again.
- **Spec answers:** whether the runner keeps the form open waiting (minutes) or abandons and retries later (my lean: abandon and retry, so the browser isn't left sitting on a half-filled form); how the author is told a question is waiting.

### 16 Launch check

- **Scope:** the Phase 2 exit criteria, checked end to end with the real 10xjobs dev environment and the author's account. Fixes found go in their own small PRs.

### 17 Tailored resumes

- **Scope:** each application uploads a resume tailored to that job instead of the fixed one, produced by the author's existing resume engine (its own repo), improved and reused. Not part of Phase 2's exit criteria; it follows the launch check _(user: "very soon")_.
- **Spec answers:** where the engine runs (inside 10xapply, as a service, or inside 10xjobs, sending a resume reference in the webhook); whether the author reviews a tailored resume before it is used; how the resume is chosen when tailoring fails (fall back to the fixed one, or block).

## Phase 3: Friends (headlines only)

Applications run on our servers instead of the author's machine, so friends can use 10xapply without running anything. Each gets a roadmap brainstorm before it starts.

- Browser server and residential IPs: our own server for browsers, a proxy provider, one dedicated static residential (ISP) IP per user near their location, a persistent profile per user (from `CLAUDE.md`).
- Hosted sign-in: a live view the user drives to sign in to LinkedIn; we never see the password. Session storage, encrypted, never logged; expiry detection and a request to sign in again.
- Hosted workers and Redis queues: one run at a time per account, per-account caps and pacing, many accounts on one server.
- Moving the author's account from the home machine to the server. This is a new device and IP to LinkedIn, so it gets its own care (for example, signing in fresh through the live view and starting with low caps).
- Onboarding friends: invites, fact bank setup, linking their 10xjobs email.
- Account health: watching for LinkedIn warnings across accounts, and a kill switch per account and for everyone.

## Phase 4: External jobs posted on LinkedIn (headline only)

Jobs that send the applicant from LinkedIn to the company's own site (Greenhouse, Ashby, Workday and others), where every form differs.

## Later: other channels

Indeed and other job boards.
