import { z } from 'zod';

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TAG_PATTERN = ID_PATTERN;
export const PLACEHOLDERS = ['source', 'company', 'jobTitle'] as const;

// Zod's own issue text is never shown to users. A later task maps these keys
// (the `error` of each check) to messages.
const str = z.string().trim().min(1);
const kebab = str.regex(ID_PATTERN, { error: 'format:kebab' });
const tags = z.array(kebab);

const date = str.refine(
  (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = new Date(Date.UTC(y, mo - 1, d));
    return (
      t.getUTCFullYear() === y &&
      t.getUTCMonth() === mo - 1 &&
      t.getUTCDate() === d
    );
  },
  { error: 'format:date' },
);

const https = str.refine((s) => s.startsWith('https://'), {
  error: 'format:https',
});

const fact = z.union([
  str,
  z.strictObject({
    text: str,
    tags: tags.optional(),
    confirmed: date.optional(),
  }),
]);

const variant = z.strictObject({
  when: str,
  answer: str,
  tags: tags.optional(),
  confirmed: date.optional(),
});

const answer = z
  .strictObject({
    id: kebab,
    question: str,
    answer: str.optional(),
    variants: z.array(variant).min(1).optional(),
    tags: tags.optional(),
    confirmed: date.optional(),
  })
  .refine((a) => (a.answer === undefined) !== (a.variants === undefined), {
    error: 'one-of-answer-variants',
  });

const story = z.strictObject({
  id: kebab,
  title: str,
  story: str,
  tags: tags.min(1),
});

const fields = z.strictObject({
  firstName: str,
  lastName: str,
  email: str.refine((s) => s.includes('@'), { error: 'format:email' }),
  phone: z.strictObject({
    countryCode: str.regex(/^\+\d{1,4}$/, { error: 'format:country-code' }),
    number: str.regex(/^(?=.*\d)[\d ]+$/, { error: 'format:digits' }),
    country: str,
  }),
  city: str,
  country: str,
  links: z.strictObject({
    linkedin: https,
    github: https.optional(),
    portfolio: https.optional(),
    website: https.optional(),
  }),
  resume: str,
});

export const factBankSchema = z.strictObject({
  version: z.literal('1'),
  fields,
  facts: z.array(fact),
  answers: z.array(answer),
  stories: z.array(story),
});

export type FactBankFile = z.infer<typeof factBankSchema>;
