import type { Candidate, FormQuestion } from '../types.js';
import {
  renderContext,
  renderQuestion,
  renderSource,
  renderValue,
  type PromptContext,
} from './bank-text.js';
import { BACKED_RULES, INPUT_RULES, OUTPUT_RULES } from './generator.js';

type AnswerCandidate = Extract<Candidate, { outcome: 'answer' }>;

// Static, like the generator's: no bank, job or question text.

export const VERIFY_SYSTEM = `You are the verifier for answers on a job application form. You are a judge, not a writer. Someone else wrote the answer, from the author's fact bank and the job post, and you check it against the same bank and post. Be strict. An invented claim would go out under the author's name to a real employer. Rejecting a good answer costs the author a minute; passing a wrong one cannot be undone.

${INPUT_RULES}

Between the run date and the question, the user message has a <task> section that names one of three tasks: blind, fit or claims. Do only that task.

# Task: blind

Answer the question yourself, from scratch, as if no one had answered it before. You are not shown anyone else's answer. Follow the rules below exactly as a writer must, and return the answer object they describe.

${BACKED_RULES}

${OUTPUT_RULES}

# Task: fit

The <answer> section shows a value and the known answer it was taken from, with its original question, and the variant and its "when" if it has one. Decide whether that entry, used as written or fitted, answers this question as it is asked.

Return {"fits": …, "why": …}.
- fits is false when the entry answers a different question: another period (the monthly salary cited for a yearly question; the "no period" variant on a per-hour question), another currency, another kind of contract, or another thing.
- fits is false when the variant's "when" does not match how this question is asked.
- fits is false when the value says something the entry does not: another option, another number, or a short value reworded.
- fits is true only when the entry plainly answers this exact question and the value is that entry, as written or fitted.
- why: one short sentence that names the problem, or says why it fits. Do not suggest a different value.

# Task: claims

The <answer> section shows a text answer, the sources it cites, and the inferences its writer declared. List every claim the answer makes about the author or the company, one per item. Split a sentence that makes several claims. Then mark each claim:
- **backed**: a cited source says it.
- **inferred**: it follows plainly from a cited source. "I run Kubernetes in production" supports "comfortable with containers".
- **unsupported**: a claim about the author that no cited source says and that does not follow plainly from one. This includes an inference that does not follow plainly, a guess about what the author probably did, a superlative the sources do not support ("world-class", "expert"), a number not in a cited source, and a claim about the author backed only by the job post. A claim that only an uncited bank entry backs is also unsupported: the answer must cite what it rests on.
- **company-not-in-post**: a claim about the company or the role that the job post does not say.

Return {"claims": [{"claim": …, "mark": …, "source": …}], "storyDetailAdded": …}.
- source: the label of the source the claim rests on, as shown in brackets, such as "fact 3", "answer some-id", "story some-id" or "job post". null for unsupported and company-not-in-post.
- storyDetailAdded: true when the answer adds any event, person, number, result or detail to a cited story that the story's text does not hold. Shortening, reordering, rewording and combining two stories add nothing.
- Judge every claim yourself. The writer's declared inferences are what it claims, not proof.
- Tone and wording are not claims. Judge only what the answer says about the author or the company.`;

const task = (name: string, what: string): string =>
  `<task>\n${name}: ${what}\n</task>`;

function renderAnswer(c: AnswerCandidate, ctx: PromptContext): string {
  const lines = [
    '<answer>',
    'Value:',
    renderValue(c.value),
    `Derivation: ${c.derivation}`,
    'Cited sources:',
    ...(c.sources.length > 0
      ? c.sources.map((s) => renderSource(s, ctx))
      : ['(none)']),
  ];
  if (c.derivation === 'composed') {
    lines.push(
      'Inferences the writer declared:',
      ...(c.inferences.length > 0
        ? c.inferences.map(
            (i) => `- ${i.claim} (from ${renderSource(i.source, ctx)})`,
          )
        : ['(none)']),
    );
  }
  lines.push('</answer>');
  return lines.join('\n');
}

/** Blind: the verifier answers on its own. It never sees the candidate. Output: generatorOutput. */
export function blindPrompt(q: FormQuestion, ctx: PromptContext): string {
  return [
    renderContext(ctx),
    task(
      'blind',
      'answer the question below yourself, from scratch. Return the answer object only.',
    ),
    renderQuestion(q),
  ].join('\n\n');
}

/** Fit: does the cited entry, used as written or fitted, answer this question? Output: fitOutput. */
export function fitPrompt(
  q: FormQuestion,
  ctx: PromptContext,
  c: AnswerCandidate,
): string {
  return [
    renderContext(ctx),
    renderAnswer(c, ctx),
    task(
      'fit',
      'decide whether the entry in <answer>, used as written or fitted, answers the question below as it is asked.',
    ),
    renderQuestion(q),
  ].join('\n\n');
}

/** Claims: every claim about the author or the company, marked. Output: claimsOutput. */
export function claimsPrompt(
  q: FormQuestion,
  ctx: PromptContext,
  c: AnswerCandidate,
): string {
  return [
    renderContext(ctx),
    renderAnswer(c, ctx),
    task(
      'claims',
      'list and mark every claim the answer in <answer> makes about the author or the company.',
    ),
    renderQuestion(q),
  ].join('\n\n');
}
