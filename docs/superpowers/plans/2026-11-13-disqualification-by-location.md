# Disqualification by Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A job that requires the applicant to be in a country the user doesn't live in, stated in the posting or asked on the form, ends `disqualified` before anything is filled, unless a relocation offer quoted from the posting covers that country.

**Architecture:** Everything reuses slice 05b's `libs/disqualify` (extractor, claim checks, `decide`, rules file, golden eval) and the runner's two checkpoints. This slice adds three claim kinds and one logged kind, a `locatedIn` list in the rules file, more regions in the fixed table, a second exemption family in `decide`, a revised prompt and a `location` group in the golden set. The runner only passes relocation offers along with sponsorship offers.

**Tech Stack:** Nx 24, pnpm, TypeScript (nodenext, strict), Vitest, zod ^4, yaml ^2, `claude -p` through `@xapply/answerer`'s `ModelCaller`.

**Spec:** `docs/superpowers/specs/2026-11-13-disqualification-by-location-design.md` (builds on `docs/superpowers/specs/2026-11-13-disqualification-design.md`).

## Global Constraints

- Branch `slice-05c-location`, created from `origin/main` (05b's PR #6 is merged there). Never work on `main`. Leave the unrelated local change to `.claude/settings.json` uncommitted.
- **Never name the private folder in a Bash command or a commit message.** The guard blocks it. Claude never reads the author's `disqualify.yaml`, bank or full reports. Claude may read `run-reports/`.
- `libs/disqualify` still never imports `@xapply/fact-bank`, and the extractor's prompts still never hold the rules.
- Countries are ISO 3166-1 alpha-2, upper case. Regions are expanded only by the table in `libs/disqualify/src/countries.ts`. A region name outside the table stays an invalid token: asked again once, then `check-failed`.
- `locatedIn` is required in the rules file: at least one ISO code, no regions, no default.
- Location rules are country level. A city or area counts as its country, and any place inside a `locatedIn` country passes.
- `offers-relocation` counts only from the job page and exempts only `requires-location` and `asks-location`. `offers-sponsorship` exempts only the authorization family (not `no-sponsorship`, as in 05b). An offer with `countries: []` exempts every country in its own family.
- A location rule claim with `countries: []` is unclear: logged, never disqualifies.
- Never skips: open "where are you located" questions, relocation willingness, soft wording ("preferably in", "our Berlin office", "open to candidates in Europe", "Germany (Remote)"), time zones, language.
- Redacted outputs never hold a quote, label or `detail`. No change to that.
- The extract call count stays at one per checkpoint.

## Review Focus

1. **The author's existing `disqualify.yaml` lacks `locatedIn`.** Expect `facts-check` to print `locatedIn: is required` and `runner apply` to stop before the job page with the rules-file error, never to run with location rules off. Test in Task 1 (`a rules file without locatedIn is invalid`).
2. **A posting that offers relocation and also says "no visa sponsorship".** Expect `disqualified` from `no-sponsorship`: the relocation offer never crosses families. Test in Task 3 (`relocation offer does not exempt authorization`).
3. **A sponsorship offer with a location requirement** ("we sponsor visas", "must be based in Berlin"). Expect `disqualified` from `requires-location`. Test in Task 3 (`sponsorship offer does not exempt location`).
4. **The model writes a region outside the table**, for example `NORDICS`. Expect the claim check to reject it and the run to end `check-failed` after one retry, never a skip or a pass. Test in Task 2 (`unknown region stays invalid`).
5. **A relocation offer the model reports from a form question.** Expect the claim check to reject it (`offers-relocation must come from the job page`), so a form can't exempt itself. Test in Task 2 (`offers-relocation must come from the job page`).

---

### Task 1: Branch, spec, and `locatedIn` in the rules file

**Files:**

- Modify: `libs/disqualify/src/rules.ts` (schema, `Rules`, `RulesCheck.counts`, `parseRules`, `checkRules`)
- Modify: `libs/disqualify/src/rules.spec.ts`
- Modify: `libs/disqualify/disqualify.example.yaml`
- Modify: `libs/disqualify/golden/example.yaml` (`rules:` block only)
- Modify: `apps/runner/src/commands/facts.ts:42` and its spec if it asserts the line
- Modify: `docs/roadmap/README.md` (05c: add a `**Spec:**` link line, as 05b has)

**Interfaces:**

- Produces: `interface Rules { authorizedCountries: string[]; locatedIn: string[] }` and `RulesCheck.counts: { authorizedCountries: number; locatedIn: number }`. Both lists de-duplicated and upper-cased like `authorizedCountries` today.

- [ ] **Step 1: Branch and commit the spec**

```bash
git fetch origin && git switch -c slice-05c-location origin/main
git add docs/superpowers/specs/2026-11-13-disqualification-by-location-design.md docs/superpowers/plans/2026-11-13-disqualification-by-location.md
git commit -m "docs: slice 05c spec and plan, disqualification by location"
```

- [ ] **Step 2: Write the failing tests** in `rules.spec.ts`

- `parses locatedIn`: `parseRules({ authorizedCountries: ['ma'], locatedIn: ['ma', 'MA'] })` → `{ ok: true, rules: { authorizedCountries: ['MA'], locatedIn: ['MA'] } }`.
- `a rules file without locatedIn is invalid`: `parseRules({ authorizedCountries: ['MA'] })` → `ok: false`, problems contain `'locatedIn: is required'`.
- `locatedIn needs at least one code`: `locatedIn: []` → problems contain `'locatedIn: needs at least one country code'`.
- `locatedIn rejects regions`: `locatedIn: ['EU']` → problems contain `'locatedIn[0]: is not a country code'`.
- `checkRules counts locatedIn`: a temp file with both lists → `counts.locatedIn === 1`.
- Update every existing fixture in the spec that builds a valid rules object to include `locatedIn: ['MA']`.

- [ ] **Step 3: Run to see them fail**

Run: `pnpm nx test disqualify -- rules`
Expected: FAIL on the new cases.

- [ ] **Step 4: Implement.** Add `locatedIn` to the zod `strictObject` with the same element schema and `.min(1)` as `authorizedCountries`. The existing `problemsOf` already produces the messages above. Example file: add `locatedIn: [MA]` with a comment in the same style ("countries where you live; a city counts as its country; at least one; no regions"). Golden `rules:` gains `locatedIn: [MA]`. `facts.ts` prints `located in ${counts.locatedIn}` after the authorized count.

- [ ] **Step 5: Run the lib and runner tests**

Run: `pnpm nx run-many -t test -p disqualify runner`
Expected: PASS. Fix any runner test that builds `Rules` without `locatedIn` by adding `locatedIn: ['MA']`.

- [ ] **Step 6: Commit**

```bash
git add libs/disqualify apps/runner/src docs/roadmap/README.md
git commit -m "feat(disqualify): rules file gains locatedIn"
```

The author must add `locatedIn: [MA]` to their own rules file. Say so in the PR body and when handing over. Claude does not edit that file.

---

### Task 2: Regions, claim kinds and claim checks

**Files:**

- Modify: `libs/disqualify/src/countries.ts`, `countries.spec.ts`
- Modify: `libs/disqualify/src/types.ts`
- Modify: `libs/disqualify/src/validate.ts`, `validate.spec.ts`

**Interfaces:**

- Produces:
  - `RULE_KINDS = ['offers-sponsorship', 'requires-authorization', 'no-sponsorship', 'asks-authorization', 'asks-sponsorship', 'offers-relocation', 'requires-location', 'asks-location']`
  - `LOG_KINDS = ['location-preference', 'language-requirement']` (`location-requirement` is removed)
  - `REGIONS` gains `EUROPE`, `EMEA`, `MENA`, `AFRICA`, `NORTH_AMERICA`, `LATAM`, `AMERICAS`, `APAC`.

- [ ] **Step 1: Write the failing tests**

`countries.spec.ts`:

- `new regions expand`: `expandCountries(['MENA']).has('MA')`, `expandCountries(['EMEA']).has('MA')`, `expandCountries(['AFRICA']).has('MA')`, `!expandCountries(['EUROPE']).has('MA')`, `expandCountries(['EUROPE'])` has `GB`, `CH`, `UA`, `TR`, `RU`; `expandCountries(['NORTH_AMERICA'])` equals `{US, CA, MX}`; `expandCountries(['AMERICAS'])` has `US`, `BR`, `AR`; `expandCountries(['LATAM'])` has `BR`, `MX` and not `US`; `expandCountries(['APAC'])` has `JP`, `AU`, `IN` and not `MA`.
- `every region member is an ISO code`: for each region, every member is in `ISO_CODES`.
- `unknown region stays invalid`: `isCountryToken('NORDICS') === false`, and `expandCountries(['NORDICS'])` throws.

`validate.spec.ts`:

- `offers-relocation must come from the job page`: a form-sourced `offers-relocation` claim → `'claim 0: offers-relocation must come from the job page'`.
- `asks-location must come from a form question`: a `job-page` `asks-location` → `'claim 0: asks-location must come from a form question'`.
- `location kinds need a detail`: `requires-location`, `asks-location` and `location-preference` with `detail: null` each give `'claim 0: detail is missing'`. `offers-relocation` with `detail: null` gives no problem.
- `a closed-list question quotes its label`: question `s1-q1` with label `Which country are you based in?` and options `Germany | Austria | Switzerland`, claim `asks-location`, countries `['DE','AT','CH']`, quote = the label, detail `Germany, Austria, Switzerland` → no problems.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm nx test disqualify -- countries validate`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `countries.ts`: each new region is a `const` code list with a one-line comment naming its source (UN M49 for `EUROPE`, `AFRICA`, `AMERICAS`. `NORTH_AMERICA` is `US CA MX`. `LATAM` is M49 Latin America and the Caribbean. `MENA` is the World Bank's Middle East and North Africa list, which includes `MA`. `EMEA` is `EUROPE ∪ MENA ∪ AFRICA`. `APAC` is M49 Asia plus Oceania, without the M49 Western Asia members already in `MENA`). Keys are upper case with `_`, matching the existing `.toUpperCase()` lookup. Update the comment on `REGIONS`.
- `types.ts`: the kind lists above. Update `Claim.detail`'s doc comment to "Location kinds: the place as written. Language: the language. Else null."
- `validate.ts`: generalise the job-page-only check to `offers-sponsorship` and `offers-relocation`, add `asks-location` to `ASKS`, and require `detail` for `requires-location`, `asks-location`, `location-preference` and `language-requirement`.
- Fix compile errors where `location-requirement` was named (`validate.spec.ts`, `extract.spec.ts` fixtures) by switching to `requires-location`.

- [ ] **Step 4: Run the lib tests and typecheck**

Run: `pnpm nx run-many -t test typecheck -p disqualify`
Expected: PASS. Failures in `prompts.spec.ts` that name `location-requirement` are fixed in Task 4. Mark them `.todo` only if needed to commit, with a pointer to Task 4.

- [ ] **Step 5: Commit**

```bash
git add libs/disqualify
git commit -m "feat(disqualify): location claim kinds and wider regions"
```

---

### Task 3: Decide on location

**Files:**

- Modify: `libs/disqualify/src/decide.ts`, `decide.spec.ts`

**Interfaces:**

- Consumes: `Rules.locatedIn` (Task 1), the kinds (Task 2).
- Produces: `decide(claims: Claim[], rules: Rules, offers: Claim[]): Verdict`. The signature is unchanged. `offers` now carries the job page's `offers-sponsorship` **and** `offers-relocation` claims. `decide` sorts them by kind, and offer claims inside `claims` are still ignored.

- [ ] **Step 1: Write the failing tests**, one per row, with rules `{ authorizedCountries: ['MA'], locatedIn: ['MA'] }`:

- `requires-location outside locatedIn disqualifies`: `requires-location ['DE']` → disqualified, reasons = that claim.
- `asks-location outside locatedIn disqualifies`: `asks-location ['DE']` → disqualified.
- `location inside locatedIn passes`: `asks-location ['MA']` → pass.
- `location any-of passes`: `requires-location ['MA','TN']` → pass.
- `location region`: `requires-location ['EU']` → disqualified, `requires-location ['MENA']` → pass.
- `unclear location passes`: `asks-location []` → pass.
- `relocation offer exempts its country`: offers `[offers-relocation ['DE']]`, `requires-location ['DE']` → pass. `requires-location ['FR']` → disqualified.
- `relocation offer with no country exempts all location`: offers `[offers-relocation []]`, `asks-location ['DE']` → pass.
- `relocation offer does not exempt authorization`: offers `[offers-relocation []]`, `no-sponsorship ['DE']` → disqualified. `asks-sponsorship ['DE']` → disqualified.
- `sponsorship offer does not exempt location`: offers `[offers-sponsorship []]`, `requires-location ['DE']` → disqualified.
- `location uses locatedIn, not authorizedCountries`: rules `{ authorizedCountries: ['DE'], locatedIn: ['MA'] }`, `asks-location ['DE']` → disqualified, `asks-authorization ['DE']` → pass.
- `log kinds never decide`: `location-preference ['DE']`, `language-requirement []` → pass.
- All existing 05b rows still pass with `locatedIn` added to their rules.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm nx test disqualify -- decide`
Expected: FAIL.

- [ ] **Step 3: Implement.** Two families in a table, each with its deciding kinds, its offer kind, its never-exempt kinds and which rules list it reads:

```ts
const FAMILIES = [
  {
    deciding: [
      'requires-authorization',
      'no-sponsorship',
      'asks-authorization',
      'asks-sponsorship',
    ],
    neverExempt: ['no-sponsorship'],
    offer: 'offers-sponsorship',
    allowed: (r: Rules) => r.authorizedCountries,
  },
  {
    deciding: ['requires-location', 'asks-location'],
    neverExempt: [],
    offer: 'offers-relocation',
    allowed: (r: Rules) => r.locatedIn,
  },
] as const;
```

Each claim is judged by the family whose `deciding` holds its kind, using 05b's existing loop. Reasons keep the claims' order. Update the doc comment.

- [ ] **Step 4: Run the tests**

Run: `pnpm nx test disqualify -- decide`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/disqualify/src/decide.ts libs/disqualify/src/decide.spec.ts
git commit -m "feat(disqualify): decide on location with relocation offers"
```

---

### Task 4: The extractor prompt

**Files:**

- Modify: `libs/disqualify/src/prompts.ts` (`EXTRACT_SYSTEM`), `prompts.spec.ts`

**Interfaces:**

- Consumes: the kinds from Task 2. The output schema `extractOutput` builds from `RULE_KINDS` and `LOG_KINDS`, so it needs no edit.

- [ ] **Step 1: Write the failing tests** in `prompts.spec.ts`, in the existing style of looking for lines in `EXTRACT_SYSTEM`:

- `names every kind`: `EXTRACT_SYSTEM` contains a numbered line starting with each of the ten kinds (`offers-sponsorship` … `language-requirement`), and the words "ten kinds". It does not contain `location-requirement` or "only logged" next to a location kind.
- `relocation is not sponsorship, and willingness is not a claim`: it contains the existing line `A relocation package, relocation support or help moving is not offers-sponsorship`, and a line saying willingness-to-relocate questions are not claims.
- `soft wording and time zones are location-preference`: it contains `preferably`, `Germany (Remote)` and `time zone` within the `location-preference` kind's text.
- `closed lists are asks-location`: it contains `Which country are you based in?` and says an `Other` option makes the question open (no claim).
- `region names`: it lists every key of `REGIONS` (build the expected list from `REGIONS` in the test, so a new region can't be left out of the prompt).

- [ ] **Step 2: Run to see them fail**

Run: `pnpm nx test disqualify -- prompts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `EXTRACT_SYSTEM`.** Keep 05b's structure and every 05b rule. The changes:

- The intro says "work authorization, visa sponsorship, location and language".
- The `countries` field rule lists every `REGIONS` key, built from `REGIONS` by interpolation, and adds: "A city, state or area becomes its country's code ("Munich area" is DE)."
- Kinds 6–8 are new: `offers-relocation` (job page only; relocation package, help moving; countries named or `[]`), `requires-location` (the text requires living in, being based in, or working on-site or hybrid in a place, or limits a remote job to a region or country: "must be based in Germany", "hybrid, 3 days a week in our Paris office", "Remote, EU only", "Remote (US)", "US only"), `asks-location` (a form question asks whether the applicant is in, or can work on-site in, a place: "Are you located in Germany?", "Are you currently located in Munich, Bavaria, Germany?", "Confirm you are located in…", "Do you live in the Munich area?", "This role is on-site in Munich, can you commit to that?". Also a question about where the applicant lives whose options are a closed list of places with no "Other" or free-text option. Its countries are the listed places and its quote is the label).
- Kind 9 `location-preference` (logged): "preferably based in Germany", "our Berlin office", "open to candidates in Europe", "Germany (Remote)" as the job's location, time-zone requirements ("within ±2 hours of CET").
- Kind 10 `language-requirement`, unchanged.
- Near-misses gain: "Where are you located?" and other open location questions (no claim). "Are you willing to relocate to Germany?" (no claim). A closed list that includes "Other" (no claim). "US-based candidates only" may be reported as `requires-location`, `requires-authorization` or both.
- `detail` for every location kind is the place as written.

- [ ] **Step 4: Run the lib tests**

Run: `pnpm nx run-many -t test lint typecheck -p disqualify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/disqualify/src/prompts.ts libs/disqualify/src/prompts.spec.ts
git commit -m "feat(disqualify): extractor prompt reports location requirements"
```

---

### Task 5: Relocation offers through the runner and the golden runner

**Files:**

- Modify: `apps/runner/src/apply/check.ts:95-97` (`offersOf`)
- Modify: `apps/runner/src/apply/step.ts:49` (doc comment only)
- Modify: `libs/disqualify/src/golden/run.ts:86`
- Test: `apps/runner/src/apply/run.spec.ts`, `apps/runner/src/apply/report.spec.ts`, `libs/disqualify/src/golden/run.spec.ts`

**Interfaces:**

- Produces: `offersOf(claims: Claim[]): Claim[]` returns the job page's `offers-sponsorship` and `offers-relocation` claims. Export a shared `OFFER_KINDS = ['offers-sponsorship', 'offers-relocation'] as const` from `libs/disqualify/src/types.ts` and use it in both places.

- [ ] **Step 1: Write the failing tests**

- `run.spec.ts`, next to the existing sponsorship-offer test near line 1656: `a relocation offer on the job page exempts a location question`. Job claims `[offers-relocation ['DE']]`, round claims `[asks-location ['DE'], 's1-q1']` → outcome `reached-review`. And `a location question disqualifies a round`: round claims `[asks-location ['DE'], 's1-q1']` with no offer → outcome `disqualified`, nothing in that round filled (assert as the existing 05b round test does).
- `run.spec.ts`: `a location requirement on the job page never opens the form`: job claims `[requires-location ['DE']]` → `disqualified`, Easy Apply never clicked (same assertion as 05b's job-page test).
- `report.spec.ts`: `location claims in the requirements table`. A `requires-location` claim with `[]` shows `unclear`. A `location-preference` with `[]` shows `-`. The redacted report has the kind and code but not the claim's `detail`.
- `golden/run.spec.ts`: `relocation offers reach decide`. A stub caller returns `offers-relocation ['DE']` for the job and `asks-location ['DE']` for the question → verdict `pass`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm nx run-many -t test -p runner disqualify`
Expected: the new offer tests FAIL. The others may already pass, which confirms the kinds flow through.

- [ ] **Step 3: Implement** `OFFER_KINDS` and the two filters. Rename any test or comment text that says "sponsorship offers" where it now means both.

- [ ] **Step 4: Run everything**

Run: `pnpm nx run-many -t test lint typecheck build -p runner disqualify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src libs/disqualify/src
git commit -m "feat(runner): relocation offers exempt location checks"
```

---

### Task 6: Golden set and eval

**Files:**

- Modify: `libs/disqualify/src/golden/format.ts` (expected `kind` may be a list), `format.spec.ts`
- Modify: `libs/disqualify/src/golden/run.ts` (`claimsMatch`), `run.spec.ts`
- Modify: `libs/disqualify/golden/example.yaml`

**Interfaces:**

- Produces: `ExpectedClaim { kind: RuleKind | RuleKind[]; countries: string[] }`. A list means any one of those kinds satisfies it (for "US-based candidates only").

- [ ] **Step 1: Write the failing tests**

- `format.spec.ts`: `an expected kind may be a list`. `kind: [requires-location, requires-authorization]` loads. `kind: [made-up]` is rejected.
- `run.spec.ts`: `a kind list matches any of its kinds`. Expected `{ kind: ['requires-location','requires-authorization'], countries: ['US'] }` is matched by a returned `requires-authorization ['US']`.

- [ ] **Step 2: Run to see them fail, implement, run to pass**

Run: `pnpm nx test disqualify -- golden`
Expected: FAIL, then PASS after `z.union([z.enum(RULE_KINDS), z.array(z.enum(RULE_KINDS)).min(1)])` and an `includes` in `claimsMatch`.

- [ ] **Step 3: Count the evidence.** Run this from the repo root and note the counts in the PR body:

```bash
grep -l 'location-requirement' run-reports/apply-*.json | wc -l; ls run-reports/apply-*.json | wc -l
```

- [ ] **Step 4: Write the cases** in `example.yaml`, in the `location` group. Flip 05b's `loc-based-in-berlin`, `loc-hybrid-paris` and `loc-onsite-question` to `disqualified` with `requires-location [DE]`, `requires-location [FR]` and `asks-location [IE]`. Add at least one case per line below, each with a short id. Use made-up companies and postings, and cover descriptions as well as questions:

- Skip: `Are you located in Germany?` · `Are you currently located in Munich, Bavaria, Germany?` · `Confirm you are located in the EU` · `Do you live in the Munich area?` · `This role is on-site in Munich, can you commit to that?` · `Which country are you based in?` with options Germany/Austria/Switzerland · posting `must be based in Germany` · `only candidates based in the UK` (`[GB]`) · `Remote, EU only` (`[EU]`) · `Remote (US)` · `Europe only` (`[EUROPE]`) · `US-based candidates only` (`kind: [requires-location, requires-authorization]`, `[US]`) · relocation offer for DE with a sponsorship requirement for DE (still skips, `no-sponsorship`) · sponsorship offer with `must be based in Berlin` (still skips).
- Pass: `Where are you located?` (text) · `City of residence` · `Are you willing to relocate to Germany?` · `preferably based in Germany` · `our Berlin office` · `open to candidates in Europe` · `Germany (Remote)` in the description's location line · `within ±2 hours of CET` · `Are you located in Casablanca?` · `hybrid in our Rabat office` · `Remote, EMEA only` · closed list with Germany/Austria/Other · closed list including Morocco · `On-site in Munich, relocation package provided` · a posting with `relocation support to Berlin` and the form's `Are you located in Germany?`.
- Every pass case expects `claims: []`. Every skip case lists only the deciding claim.

- [ ] **Step 5: Run the eval three times** (example set, allowed without asking)

Run: `pnpm nx run runner:disqualify-eval --outputStyle=stream -- --repeat 3` (`--outputStyle` goes before the `--`; after it, the runner rejects the flag)
Expected: every case passes on all three repeats, the 05b cases included. When a case fails, read its result under `run-reports/disqualify-eval/`. Fix the prompt (Task 4's file) rather than the case, unless the case contradicts the spec. Re-run until it passes, and commit the prompt fixes with this task.

- [ ] **Step 6: Commit**

```bash
git add libs/disqualify
git commit -m "test(disqualify): location golden cases, eval passes on three repeats"
```

---

### Task 7: Docs, PR and the author's dry runs

**Files:**

- Modify: `CLAUDE.md` (the `disqualify.yaml` guardrail line mentions `locatedIn`; the `runner:apply` command line says a location requirement can also end `disqualified`)
- Modify: `docs/roadmap/README.md` (05c's "Spec answers" replaced by a one-paragraph summary of what the spec settled, as 03 and 04 have)

- [ ] **Step 1: Edit both docs and run the full checks**

Run: `pnpm nx run-many -t lint test build typecheck && pnpm format:check`
Expected: PASS.

- [ ] **Step 2: Commit, push, open the PR**

```bash
git add CLAUDE.md docs/roadmap/README.md
git commit -m "docs: CLAUDE.md and roadmap for slice 05c"
git push -u origin slice-05c-location
gh pr create --base main --title "Slice 05c: disqualification by location" --body "<summary, eval result, evidence counts, and: the author must add locatedIn: [MA] to their rules file before the next run>"
```

- [ ] **Step 3: Hand over the done-when check.** Ask the author to add `locatedIn: [MA]` to their rules file, run `pnpm nx run runner:facts-check`, then run `runner:apply -- <url> --dry-run` on three jobs they pick: one that should skip from a location form question, one that should skip from the posting, and one with soft location wording that should go ahead. Claude runs them only if the author asks in that session. Claude then reads the redacted reports in `run-reports/` and confirms the verdicts with the author.
