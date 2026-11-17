import { describe, expect, it } from 'vitest';
import { linkedinJobId } from './linkedin-job-id';

const view = 'https://www.linkedin.com/jobs/view/1/';

describe('linkedinJobId', () => {
  it('takes the id from a linkedin-job key', () => {
    expect(linkedinJobId('linkedin-job:4488500594', 'anything')).toBe(
      '4488500594',
    );
  });

  it('is null for other key kinds, whatever the URL', () => {
    expect(linkedinJobId('ats:greenhouse/acme/123', view)).toBeNull();
    expect(linkedinJobId('url:https://acme.example/j|Dev', view)).toBeNull();
    expect(linkedinJobId('linkedin-post:9', view)).toBeNull();
  });

  it('is null when a linkedin-job key is not digits', () => {
    expect(linkedinJobId('linkedin-job:abc', view)).toBeNull();
  });

  it('falls back to the URL when there is no key', () => {
    expect(
      linkedinJobId(null, 'https://www.linkedin.com/jobs/view/4490505838/'),
    ).toBe('4490505838');
    expect(
      linkedinJobId(
        null,
        'https://www.linkedin.com/jobs/search/?currentJobId=4490356080',
      ),
    ).toBe('4490356080');
  });

  it('is null for non-LinkedIn or invalid URLs', () => {
    expect(
      linkedinJobId(null, 'https://boards.greenhouse.io/acme/jobs/1'),
    ).toBeNull();
    expect(linkedinJobId(null, 'not a url')).toBeNull();
  });
});
