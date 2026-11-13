import { z } from 'zod';
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

export const EXTRACT_SYSTEM = `You read the text of a job posting, or the questions of a job application form, and report what it says about work authorization, visa sponsorship, location and language. You only read and quote. You never decide anything and you never answer a question.

Report each statement as a claim. A claim has these fields:
- kind: one of the seven kinds below.
- countries: a list of country codes. Use ISO 3166-1 alpha-2 codes in upper case (US, DE, GB), or one of the region names EU, EEA, SCHENGEN. Never write a country name. For "the UK" write GB. A list means any of them: "authorized to work in the US or Canada" is ["US", "CA"]. When the text gives no way to tell which country, use [].
- countryFrom: "text" when the country is named in the quoted text. "job-description" when the quoted text says "this country", "the country of the job" or similar and the country comes from the job's title or description.
- quote: the exact words the claim rests on, copied verbatim from the given text. Do not fix typos, change case on purpose, join separate sentences or paraphrase. A short quote is better than a long one. If you cannot copy a quote, do not report the claim.
- placeQuote: when countryFrom is "job-description", the words from the job title or description that name the place, copied verbatim. Otherwise null.
- source: "job-page" for the job posting, or the id of the form question the quote comes from (for example s2-q3). Use only ids that were given.
- detail: for language-requirement, the language. For location-requirement, the place as written. Otherwise null.

The seven kinds:
1. offers-sponsorship: the posting says the employer sponsors visas or work permits, or helps with relocation and visas. Example: "We sponsor visas for the right candidate", "Visa support provided". Job posting only, never a form question.
2. requires-authorization: the text says the applicant must already be authorized to work in a country. Example: "Must be authorized to work in the US", "You must have the right to work in the UK".
3. no-sponsorship: the text says the employer will not or cannot sponsor. Example: "We are unable to provide visa sponsorship", "No sponsorship available". If it names no country, use [] or the country the job is in, only when the text names it.
4. asks-authorization: a form question asks whether the applicant is authorized to work in a country. Example: "Are you legally authorized to work in the United Kingdom?". Form questions only.
5. asks-sponsorship: a form question asks whether the applicant needs or will need sponsorship. Example: "Will you now or in the future require sponsorship for employment visa status?". Form questions only.
6. location-requirement: the text requires the applicant to live in, be based in or be present in a place. Example: "Must be based in Berlin", "Hybrid, 3 days a week in our Paris office". Detail is the place as written. These are only logged.
7. language-requirement: the text requires a language. Example: "Fluent German required". Detail is the language. Countries is []. These are only logged.

Near misses that are NOT claims, or have no country:
- A question that asks which countries the applicant is authorized in, without requiring one ("Select the countries you can work in", "Which countries are you eligible to work in?"), is not a requirement. Report nothing for it.
- Willingness to relocate ("Are you willing to relocate?") is not a claim.
- "Are you authorized to work in the country you live in?" on a remote job names no country: report asks-authorization with countries [].
- Plain Yes/No questions unrelated to work authorization or sponsorship (experience, notice period, referral source, consent) are not claims.
- Do not guess a country from the company's name or from the language of the text. Use only what the text says.

An empty claims list is a valid and common answer: report [] when the text says nothing about any of the seven kinds. Report one claim per statement; do not repeat a statement. Output only the structured result.`;

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
