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

  const jobKey = body.job.key ?? null;
  return {
    kind: 'match',
    match: {
      xjobsJobId: body.job.id,
      jobKey,
      linkedinJobId: linkedinJobId(jobKey, body.job.postingUrl),
      title: body.job.title,
      companyName: body.job.company.name,
      postingUrl: body.job.postingUrl,
      applyUrl: body.job.applyUrl ?? null,
      profileLabel: body.profile.label,
      unverified: body.match.unverified,
      matchedAt,
    },
  };
}
