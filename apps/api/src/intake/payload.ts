import { z } from 'zod';
import { linkedinJobId } from './linkedin-job-id';

export type ParsedMatch = {
  xjobsJobId: string;
  jobKey: string | null;
  linkedinJobId: string | null;
  title: string;
  companyName: string;
  postingUrl: string;
  applyUrl: string | null;
  profileLabel: string;
  unverified: boolean;
  matchedAt: Date;
};

export type ParsedDelivery =
  | { kind: 'test' }
  | { kind: 'unparsed' }
  | { kind: 'match'; match: ParsedMatch };

const text = z.string().min(1);

/**
 * Postgres text cannot hold U+0000, which an escaped `\u0000` in the JSON
 * becomes. Stripped so a signed match is stored rather than failing (and
 * being retried) or being lost to `unparsed`.
 */
function noNul(value: string): string {
  return value.replaceAll('\u0000', '');
}

// Loose objects: new fields can appear within version 1.
const matchQualified = z.looseObject({
  version: z.literal(1),
  deliveryId: text,
  createdAt: text,
  profile: z.looseObject({ label: text }),
  match: z.looseObject({ unverified: z.boolean() }),
  job: z.looseObject({
    id: text,
    key: z.string().nullish(),
    title: text,
    company: z.looseObject({ name: text }),
    postingUrl: text,
    applyUrl: z.string().nullish(),
  }),
});

/** Parses a delivery's raw body. Never throws and never logs. */
export function parseDelivery(
  rawBody: Buffer,
  event: string,
  headerDeliveryId: string,
): ParsedDelivery {
  if (event === 'test') return { kind: 'test' };
  if (event !== 'match.qualified') return { kind: 'unparsed' };

  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { kind: 'unparsed' };
  }
  const parsed = matchQualified.safeParse(json);
  if (!parsed.success) return { kind: 'unparsed' };
  const body = parsed.data;
  if (body.deliveryId !== headerDeliveryId) return { kind: 'unparsed' };
  const matchedAt = new Date(body.createdAt);
  if (Number.isNaN(matchedAt.getTime())) return { kind: 'unparsed' };

  const key = body.job.key;
  const jobKey = key === undefined || key === null ? null : noNul(key);
  const postingUrl = noNul(body.job.postingUrl);
  const applyUrl = body.job.applyUrl;
  return {
    kind: 'match',
    match: {
      xjobsJobId: noNul(body.job.id),
      jobKey,
      linkedinJobId: linkedinJobId(jobKey, postingUrl),
      title: noNul(body.job.title),
      companyName: noNul(body.job.company.name),
      postingUrl,
      applyUrl:
        applyUrl === undefined || applyUrl === null ? null : noNul(applyUrl),
      profileLabel: noNul(body.profile.label),
      unverified: body.match.unverified,
      matchedAt,
    },
  };
}
