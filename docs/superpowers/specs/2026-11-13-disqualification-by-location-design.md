# Slice 05c: Disqualification by location

Date: 2026-11-13
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 05c. Builds on [slice 05b](2026-11-13-disqualification-design.md).

## Intent

Some jobs take only candidates who are in a given place. The form asks "Are you located in Germany?", "Are you currently located in {location}?" or "Confirm you are located in…", or the posting says "must be based in Germany" _(user)_. The author lives in Morocco. Anywhere else the truthful answer is "no", and a recruiter's must-have question rejects the application on arrival, the same as with work authorization in 05b.

This slice turns 05b's logged location claims into rules. A job that requires the applicant to be somewhere other than where the user lives is marked **disqualified** before anything is filled in, with a traceable reason. It reuses 05b's extractor, checkpoints, claim checks, rules file, `disqualified` outcome, reports and golden eval. Only the claim kinds, the decision table, the rules file and the golden set change.

## Goals

- The job page and every form round are checked for location requirements as well as authorization and sponsorship, in the same single extractor call per checkpoint as 05b.
- A job that requires presence in a country the user doesn't live in ends `disqualified`, with the rule, the country, the quote and where it was found, exactly as 05b records it.
- A relocation offer quoted from the posting exempts its country from the location rules, the same way a sponsorship offer does in 05b _(user)_.
- The golden set covers the many wordings of the same requirement, in form questions and job descriptions alike _(user)_, and the near-misses that must not skip.

## Non-goals

- **Language requirements.** Still logged only, unchanged from 05b _(user)_.
- **City-level rules.** Rules are by country only. Any place in Morocco passes, whichever city the author lives in _(user)_.
- **Time-zone requirements.** "Within ±2 hours of CET" never skips _(user)_.
- **Reading LinkedIn's job location line.** The runner still has no job location (`readJobPage` returns `location: null`, see 05b). This slice doesn't add it.
- **An override.** As in 05b, the author can trace a disqualification but not overrule it.

## Anti-goals

- **Applying to a job that requires being somewhere the author isn't** when the posting or form made that clear.
- **Skipping a job over soft wording.** "Preferably in Germany", "our Berlin office", "open to candidates in Europe" and "Germany (Remote)" never skip _(user)_. A false skip loses a good job for nothing.
- **Skipping on a relocation question.** "Are you willing to relocate to Germany?" is answered from the bank like any other question and never skips _(user)_.
- **An invented relocation offer.** It counts only when its sentence is quoted from the posting and code finds that quote, like `offers-sponsorship`.
- Everything 05b lists as an anti-goal still holds: no filling of a disqualifying step, no proceeding unchecked, and the extractor never sees the bank or the rules.

## What counts

**Skips the job** when the place is not in the user's `locatedIn` countries and no relocation offer covers it _(user)_:

- A form question that requires being there now: "Are you located in Germany?", "Are you currently located in Munich, Bavaria, Germany?", "Confirm you are located in the EU", "Do you live in the Munich area?".
- A form question that requires working there in person: "This role is on-site in Munich, can you commit to that?".
- A posting statement that requires it, with or without a form question: "must be based in Germany", "only candidates based in the UK", "hybrid, 3 days a week in our Paris office", "on-site in Munich".
- Remote limited to a region or country, stated as a restriction: "Remote, EU only", "Remote (US)", "US only". Regions expand through 05b's fixed table in code (EU, EEA, Schengen, …), never by the model, so "EU only" skips the author.

- A question about where the applicant lives whose options are a closed list of places, none inside the user's countries: "Which country are you based in?" with only Germany, Austria and Switzerland _(user)_. It is an `asks-location` claim whose countries are the listed places, and the quote is the label (option text is checked against the options). A list that includes "Other" or a free-text option is an open question and never skips.

**Never skips** _(user)_:

- Open questions about where the applicant is: "Where are you located?", "City of residence". The bank answers them.
- Relocation questions and statements: "Are you willing to relocate?", "Would you relocate to Berlin?".
- Soft wording that states a preference or a listing, not a requirement: "preferably based in Germany", "our Berlin office", "open to candidates in Europe", "Germany (Remote)". The line _(my call, from the user's answers)_: "Germany (Remote)" names where the job is listed. "Remote (US)", "US only" or "EU only" in the text states who may apply, so it skips.
- Time-zone requirements.
- Any place inside a `locatedIn` country, at any level (country, region, city).

**Regions** _(my call)_. Location postings name wider regions than authorization ones do. 05b's fixed table in `countries.ts` gains `EUROPE`, `EMEA`, `MENA`, `AFRICA`, `NORTH_AMERICA`, `LATAM`, `AMERICAS` and `APAC`, each a fixed list of codes in code with a comment naming its source. Morocco is in `EMEA`, `MENA` and `AFRICA`, so "Remote, EMEA only" goes ahead for the author. It is not in `EUROPE`, so "Europe only" skips. `EUROPE` means the geographic continent (GB, CH, UA, TR included, Russia included). A region name outside the table is still rejected by the claim check, as in 05b. After one retry it stops the run with `check-failed`, which can be retried, never a guess.

**City below country.** A city or area outside the user's countries counts as its country: "Are you in the Munich area?" is `DE` and skips the author. The model writes the code for the city, as it already writes codes for country names in 05b. The quote is code-checked, and the eval checks the city-to-country mapping.

**Overlap with authorization.** "US-based candidates only" can mean residence, work authorization or both. The extractor may produce either claim kind, or both. For the author every reading skips, and the eval accepts any disqualifying claim with the right country _(my call)_.

## The rule

05b's table gains three rows. Its existing rows are unchanged.

| Claim                                                                                  | Found on         | Country in `locatedIn` | Country not in `locatedIn`                                 |
| -------------------------------------------------------------------------------------- | ---------------- | ---------------------- | ---------------------------------------------------------- |
| `offers-relocation` ("relocation package provided", "we help you move to Berlin")      | job page         | (nothing to do)        | Exempts that country from the two rows below for this run. |
| `requires-location` ("must be based in Germany", "Remote, EU only", "hybrid in Paris") | job page or form | pass                   | **disqualified**, unless exempt                            |
| `asks-location` ("Are you located in Germany?", "on-site in Munich, can you commit?")  | form question    | pass                   | **disqualified**, unless exempt                            |
| `location-preference` (soft wording, time zones)                                       | job page or form | logged only            | logged only                                                |
| `language-requirement`                                                                 | job page or form | logged only            | logged only                                                |

- **Relocation offer and sponsorship offer stay separate.** A relocation offer never exempts an authorization or sponsorship claim, and a sponsorship offer never exempts a location claim, as 05b already decided ("relocation help alone is not a sponsorship offer"). A job that needs both a visa and a move passes only when the posting offers both.
- **An offer with no country** exempts every country, as `offers-sponsorship` with `[]` does in 05b.
- **Unclear country.** A location question that names no place and whose job description names none either ("Are you located in the job's location?" on a posting with no place) has countries `[]`. It is logged and doesn't skip, as in 05b. When the description names the place, the claim takes it with `country-from: job-description` and a code-checked `placeQuote`, as in 05b.
- **Any-of.** A list of countries passes if any one is in `locatedIn` ("based in Morocco or Tunisia" passes the author), as in 05b.

`location-requirement` (05b's logged kind) is replaced by `requires-location` and `location-preference`. The builder may keep the old name for the requirement kind if renaming costs more than it's worth. Old redacted reports aren't migrated.

## The rules file

`disqualify.yaml` gains a required list next to `authorizedCountries` _(my call)_:

```yaml
authorizedCountries: [MA]
locatedIn: [MA]
```

- `locatedIn` lists where the user lives, as ISO 3166-1 alpha-2 codes, at least one, no regions and no cities. It is separate from `authorizedCountries` because a friend in Phase 3 may live in one country and be authorized in another, even though the two lists are the same for the author.
- It is required, with no default, so the run never guesses where the user lives. The author's existing file fails `facts-check` until the line is added, and a run stops before the job page as it does today for a bad rules file. The committed example gains the line with a fake value.
- `facts-check` prints its count like `authorizedCountries`, never a value.
- The extractor still never sees the rules or the bank (roadmap, locked), so it can't tell whether a city is the author's. It only reports the place and its country. Code decides.

## The extractor

Same role, model, call, input, output shape and checks as 05b. The prompt changes:

- The three new kinds and `location-preference` replace `location-requirement`, with the wordings above as examples and the never-skip list as near-misses.
- For location kinds, `countries` holds the country of the place (a city becomes its country code) or a region name, and `detail` keeps the place as written ("Munich area").
- "Willing to relocate" stays a near-miss with no claim. A relocation offer becomes `offers-relocation`, on the job page only.

Whether the prompt grows or the location part becomes its own prompt section is the builder's call. It stays one call per checkpoint _(my call)_, so the run gets no slower.

## What gets recorded

Unchanged from 05b. A location disqualification records the rule (`requires-location` or `asks-location`), the country, `country-from`, the quote and where it was found. The full report's "Requirements" section lists `offers-relocation` and `location-preference` claims with the rest. The redacted report keeps kinds, codes, sources and the verdict, with no quotes. `detail` holds the place as written, so it goes in the full report only.

## The eval

- 05b's committed set gains a `location` group. Hits cover every wording named in this spec, in form questions and in descriptions: located-in questions (country, `{location}` template filled with city, region and country, "confirm you are located in"), on-site commitment questions, "must be based in", "only candidates in", hybrid and on-site office days, "Remote, EU only", "Remote (US)", "US only", city and area questions outside Morocco.
- Closed-list cases: options with no Moroccan place (skip), and options with "Other" or Morocco (pass).
- Near-misses that must pass: open "where are you located" questions, relocation willingness, the four soft wordings above, time zones, a Moroccan city ("Are you located in Casablanca?", "hybrid in our Rabat office"), and a location requirement covered by a quoted relocation offer.
- Mixed cases: a relocation offer with a sponsorship requirement (still skips), a sponsorship offer with a location requirement (still skips), "US-based candidates only" (accepts either kind).
- The set's `rules` block gains `locatedIn: [MA]`. Cases are written by Claude from the wordings above. Real posting sentences are added in Phase 2, as in 05b.
- Before writing cases, Claude counts the location claims in `run-reports/` from 05b's runs as a check on how often they appear. The redacted reports have no quotes, so they give counts, not wordings. As of this spec, 4 of the 6 runs since 05b had at least one.
- **Pass bar:** every location hit gives the right verdict and country, no near-miss gives a disqualifying claim, and all of 05b's existing cases still pass, on three repeats.

## Where the code goes

- `libs/disqualify`: the claim kinds, the prompt, the decision (a second exemption set for relocation offers, `locatedIn` for location kinds), the rules schema and its check, the example rules file and the golden set.
- `apps/runner/src/apply/`: probably only passing relocation offers through with the sponsorship offers from the job-page checkpoint, and the report's kind names.

## Done when

- Unit tests cover the new decision rows one by one: location pass and skip, the relocation exemption, a relocation offer not exempting authorization, a sponsorship offer not exempting location, `[]` unclear, any-of, a region, and a missing `locatedIn` in the rules file.
- The eval passes its bar.
- The author runs `runner apply --dry-run` on at least one real job that should skip from a location form question, one that should skip from the posting, and one with soft location wording that should go ahead, and confirms the reasons in the report. The author picks the jobs. Claude may run them only when the author asks in that session (CLAUDE.md).

## Left to the builder

- The prompt's wording, the exact field names, and whether `location-requirement` is renamed.
- The size of the golden set, as long as it covers the wordings listed above.
- Whether the decision stays one function or splits by rule family.
