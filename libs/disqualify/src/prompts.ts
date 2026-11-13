import { z } from 'zod';
import { REGIONS } from './countries.js';
import { LOG_KINDS, RULE_KINDS } from './types.js';
import type { CheckJob, CheckQuestion } from './types.js';

/** Flat shape: every key is present, and a key that does not apply is null. */
export const extractOutput = z.object({
  claims: z.array(
    z.object({
      kind: z.enum([...RULE_KINDS, ...LOG_KINDS]),
      countries: z.array(z.string()),
      countryFrom: z.enum(['text', 'job-description']),
      quote: z.string(),
      placeQuote: z.string().nullable(),
      source: z.string(),
      detail: z.string().nullable(),
    }),
  ),
});

const REGION_NAMES = Object.keys(REGIONS).join(', ');

export const EXTRACT_SYSTEM = `You read the text of a job posting, or the questions of a job application form, and report what it says about work authorization, visa sponsorship, location and language. You only read and quote. You never decide anything and you never answer a question.

Report each statement as a claim. A claim has these fields:
- kind: one of the ten kinds below.
- countries: a list of country codes. Use ISO 3166-1 alpha-2 codes in upper case (US, DE, GB), or one of the region names ${REGION_NAMES}. Write the table names exactly: "Europe" is EUROPE, "the EU" is EU, "North America" is NORTH_AMERICA. A city, state or area becomes its country's code ("Munich area" is DE). Never write a country name. For "the UK" write GB. A list means any of them: "authorized to work in the US or Canada" is ["US", "CA"]. When the text gives no way to tell which country, use [].
- countryFrom: "text" when the country is named in the quoted text. "job-description" when the quoted text says "this country", "the country of the job" or similar and the country comes from the job's title or description.
- A sponsorship, work authorization or location question or statement that names no country or place ("Will you now or in the future require sponsorship for employment visa status?", "Are you legally authorized to work?", "Can you work on-site at our office?", "Are you located in the job's location?") is about the country of this job: when the job's title or description names where the job is, use that country with countryFrom "job-description" and copy the words that name the place as placeQuote. When the job names no place, use [].
- quote: the exact words the claim rests on, copied verbatim from the given text. Do not fix typos, change case on purpose, join separate sentences or paraphrase. A short quote is better than a long one. If you cannot copy a quote, do not report the claim.
- placeQuote: when countryFrom is "job-description", the words from the job title or description that name the place, copied verbatim. Otherwise null.
- source: "job-page" for the job posting, or the id of the form question the quote comes from (for example s2-q3). Use only ids that were given.
- detail: for language-requirement, the language. For every location kind (requires-location, asks-location, location-preference), the place as written ("Munich area"). Otherwise null.

The ten kinds:
1. offers-sponsorship: the posting says the employer sponsors visas or work permits, or gives visa or work permit support. The offer must be about visas, work permits or sponsorship. Relocation help alone is not an offer. Example: "We sponsor visas for the right candidate", "Visa support provided". Countries are the countries the offer names ("We sponsor visas in Germany" is ["DE"]); use [] only when the offer names no country. Job posting only, never a form question.
2. requires-authorization: the text says the applicant must already be authorized to work in a country. Example: "Must be authorized to work in the US", "You must have the right to work in the UK".
3. no-sponsorship: the text says the employer will not or cannot sponsor. Example: "We are unable to provide visa sponsorship", "No sponsorship available". If it names no country, use [] or the country the job is in, only when the text names it.
4. asks-authorization: a form question asks whether the applicant is authorized to work in a country. Example: "Are you legally authorized to work in the United Kingdom?". A question asking whether the applicant is a citizen, national or permanent resident of a country counts too, because employers use it as a work-authorization screen: "Are you a US citizen?" is asks-authorization with countries [US]. Form questions only.
5. asks-sponsorship: a form question asks whether the applicant needs or will need sponsorship. Example: "Will you now or in the future require sponsorship for employment visa status?". Form questions only.
6. offers-relocation: the posting offers a relocation package, relocation support or help moving. Example: "Relocation package provided", "We help you move to Berlin". Countries are the countries the offer names, or [] when it names none. Detail is null. Job posting only, never a form question.
7. requires-location: the text requires the applicant to live in, be based in, or work on-site or hybrid in a place, or limits a remote job to a region or country. Example: "Must be based in Germany", "Hybrid, 3 days a week in our Paris office", "On-site in Munich", "Remote, EU only", "Remote (US)", "US only". Job posting or form question. Countries are the place's country or region. Detail is the place as written.
8. asks-location: a form question asks whether the applicant is in, or can work on-site in, a place. Example: "Are you located in Germany?", "Are you currently located in Munich, Bavaria, Germany?", "Confirm you are located in the EU", "Do you live in the Munich area?", "This role is on-site in Munich, can you commit to that?". Also a question about where the applicant lives whose options are a closed list of places with no "Other" or free-text option ("Which country are you based in?" with only Germany, Austria and Switzerland): its countries are the listed places and its quote is the label. Form questions only. Detail is the place as written (for a closed list, the label).
9. location-preference: soft wording that states a preference or a listing, not a requirement. Example: "preferably based in Germany", "our Berlin office", "open to candidates in Europe", "Germany (Remote)" as the job's location, a time zone requirement ("within +-2 hours of CET"). Detail is the place or time zone as written. For a time zone, countries is [] (never write a zone like CET as a country).
10. language-requirement: the text requires a language. Example: "Fluent German required". Detail is the language. Countries is [].

Claims of kinds 1 to 8 can change what happens to the application, so report them only when the text really says them. Kinds 9 and 10 are only noted.

Near misses that are NOT claims, or have no country:
- A question that asks which countries the applicant is authorized in, without requiring one ("Select the countries you can work in", "Which countries are you eligible to work in?"), is not a requirement. Report nothing for it.
- Willingness to relocate ("Are you willing to relocate?", "Are you willing to relocate to Germany?", "Candidates must be willing to relocate to Berlin") is not a claim.
- An open question about where the applicant is ("Where are you located?", "City of residence") is not a claim. A question about where the applicant lives whose options include "Other" or a free-text box is an open question: no claim.
- Soft location wording and time zones are location-preference, never requires-location.
- "US-based candidates only" may be reported as requires-location, requires-authorization, or both.
- A relocation package, relocation support or help moving is not offers-sponsorship unless the same text says visas, work permits or sponsorship.
- "Are you authorized to work in the country you live in?" on a remote job names no country: report asks-authorization with countries [].
- Plain Yes/No questions unrelated to work authorization or sponsorship (experience, notice period, referral source, consent) are not claims.
- Do not guess a country from the company's name or from the language of the text. Use only what the text says.

An empty claims list is a valid and common answer: report [] when the text says nothing about any of the ten kinds. Report one claim per statement; do not repeat a statement (the one exception: "US-based candidates only" may give both requires-location and requires-authorization). Output only the structured result.`;

function formatJob(job: CheckJob): string {
  return `Job title: ${job.title}\nCompany: ${job.company}\n\nJob description:\n${job.description}`;
}

export function jobPrompt(job: CheckJob): string {
  return `Read this job posting. The source of every claim is "job-page".\n\n${formatJob(job)}`;
}

function formatQuestion(q: CheckQuestion): string {
  const lines = [`Question id: ${q.id}`, `Label: ${q.label}`];
  if (q.type) lines.push(`Type: ${q.type}`);
  if (q.options?.length) lines.push(`Options: ${q.options.join(' | ')}`);
  if (q.helpText) lines.push(`Help text: ${q.helpText}`);
  if (q.stepTitle) lines.push(`Step title: ${q.stepTitle}`);
  return lines.join('\n');
}

export function questionsPrompt(
  questions: CheckQuestion[],
  job: CheckJob,
): string {
  return `Read these questions from a job application form. The source of every claim is the id of the question its quote comes from. The job is given only so you can tell which country a question means; do not report claims from it.

${questions.map(formatQuestion).join('\n\n')}

--- The job ---
${formatJob(job)}`;
}

export function retryPrompt(original: string, problems: string[]): string {
  return `${original}

--- Problems with your previous answer ---
${problems.map((p) => `- ${p}`).join('\n')}

Reply again with the full, corrected claim list. Drop any claim you cannot quote verbatim from its source.`;
}
