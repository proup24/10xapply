import { describe, expect, it } from 'vitest';
import { parseDelivery } from './payload';

const id = '0193f0e2-aaaa';
const base = () => ({
  version: 1,
  event: 'match.qualified',
  deliveryId: id,
  createdAt: '2026-11-16T10:00:00.000Z',
  profile: {
    id: 'p1',
    position: 'backend_engineer',
    label: 'Backend engineer',
  },
  trigger: 'decision',
  match: { id: 'm1', unverified: false, stackScore: 0.72, reasons: [] },
  job: {
    id: 'j1',
    key: 'linkedin-job:4488500594',
    title: 'Senior Backend Engineer',
    company: { name: 'Acme', url: 'https://acme.example' },
    postingUrl: 'https://www.linkedin.com/jobs/view/4490505838/',
    applyUrl: 'https://acme.example/jobs/1',
  },
});
const buf = (o: unknown) =>
  Buffer.from(typeof o === 'string' ? o : JSON.stringify(o));

describe('parseDelivery', () => {
  it('parses a valid match', () => {
    expect(parseDelivery(buf(base()), 'match.qualified', id)).toEqual({
      kind: 'match',
      match: {
        xjobsJobId: 'j1',
        jobKey: 'linkedin-job:4488500594',
        linkedinJobId: '4488500594',
        title: 'Senior Backend Engineer',
        companyName: 'Acme',
        postingUrl: 'https://www.linkedin.com/jobs/view/4490505838/',
        applyUrl: 'https://acme.example/jobs/1',
        profileLabel: 'Backend engineer',
        unverified: false,
        matchedAt: new Date('2026-11-16T10:00:00.000Z'),
      },
    });
  });

  it('handles a missing job.key by using the posting URL', () => {
    const b = base();
    delete (b.job as { key?: string }).key;
    const r = parseDelivery(buf(b), 'match.qualified', id);
    expect(r).toMatchObject({
      kind: 'match',
      match: { jobKey: null, linkedinJobId: '4490505838' },
    });
  });

  it('keeps a null applyUrl', () => {
    const b = base();
    (b.job as { applyUrl: string | null }).applyUrl = null;
    expect(parseDelivery(buf(b), 'match.qualified', id)).toMatchObject({
      kind: 'match',
      match: { applyUrl: null },
    });
  });

  it('ignores extra fields', () => {
    const b = { ...base(), extra: 1, job: { ...base().job, more: [1] } };
    expect(parseDelivery(buf(b), 'match.qualified', id).kind).toBe('match');
  });

  it('strips NUL characters from the match fields', () => {
    const b = base();
    b.job.title = 'a\u0000b';
    b.job.company.name = '\u0000Acme';
    b.profile.label = 'Backend\u0000 engineer';
    b.job.key = 'linkedin-job:4488\u0000500594';
    const r = parseDelivery(buf(b), 'match.qualified', id);
    expect(r).toMatchObject({
      kind: 'match',
      match: {
        title: 'ab',
        companyName: 'Acme',
        profileLabel: 'Backend engineer',
        jobKey: 'linkedin-job:4488500594',
        linkedinJobId: '4488500594',
      },
    });
    expect(JSON.stringify(r)).not.toContain('\\u0000');
  });

  it('is a test when the signed body and the header both say test', () => {
    // A test need not pass the match schema.
    expect(parseDelivery(buf({ event: 'test' }), 'test', id)).toEqual({
      kind: 'test',
    });
    expect(
      parseDelivery(buf({ ...base(), event: 'test' }), 'test', id),
    ).toEqual({ kind: 'test' });
  });

  it('is unparsed for a test header over a body that is not JSON', () => {
    expect(parseDelivery(buf('not json'), 'test', id)).toEqual({
      kind: 'unparsed',
    });
  });

  it('is unparsed for a test header over a match body (the header is unsigned)', () => {
    expect(parseDelivery(buf(base()), 'test', id)).toEqual({
      kind: 'unparsed',
    });
  });

  it('is unparsed for a match header over a test body (the header is unsigned)', () => {
    expect(
      parseDelivery(buf({ ...base(), event: 'test' }), 'match.qualified', id),
    ).toEqual({ kind: 'unparsed' });
  });

  it('is unparsed for a body without an event', () => {
    const b: Record<string, unknown> = base();
    delete b['event'];
    expect(parseDelivery(buf(b), 'match.qualified', id)).toEqual({
      kind: 'unparsed',
    });
    expect(parseDelivery(buf({}), 'test', id)).toEqual({ kind: 'unparsed' });
  });

  it.each(['null', '[]', '"test"', '1'])(
    'is unparsed for a JSON body that is not an object (%s)',
    (raw) => {
      expect(parseDelivery(buf(raw), 'test', id)).toEqual({
        kind: 'unparsed',
      });
    },
  );

  it('is unparsed for version 2', () => {
    expect(
      parseDelivery(buf({ ...base(), version: 2 }), 'match.qualified', id),
    ).toEqual({
      kind: 'unparsed',
    });
  });

  it('is unparsed when the delivery id differs from the header', () => {
    expect(parseDelivery(buf(base()), 'match.qualified', 'other')).toEqual({
      kind: 'unparsed',
    });
  });

  it('is unparsed when a required field is missing', () => {
    const b = base();
    delete (b.job as { title?: string }).title;
    expect(parseDelivery(buf(b), 'match.qualified', id)).toEqual({
      kind: 'unparsed',
    });
  });

  it('is unparsed for a bad createdAt', () => {
    expect(
      parseDelivery(
        buf({ ...base(), createdAt: 'nope' }),
        'match.qualified',
        id,
      ),
    ).toEqual({ kind: 'unparsed' });
  });

  it('is unparsed for a body that is not JSON', () => {
    expect(parseDelivery(buf('not json'), 'match.qualified', id)).toEqual({
      kind: 'unparsed',
    });
  });

  it('is unparsed for another event', () => {
    expect(parseDelivery(buf(base()), 'match.updated', id)).toEqual({
      kind: 'unparsed',
    });
    expect(
      parseDelivery(
        buf({ ...base(), event: 'match.updated' }),
        'match.updated',
        id,
      ),
    ).toEqual({ kind: 'unparsed' });
  });
});
