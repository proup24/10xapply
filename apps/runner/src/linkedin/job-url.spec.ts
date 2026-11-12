import { describe, expect, it } from 'vitest';
import { jobViewUrl, parseJobUrl } from './job-url.js';

describe('parseJobUrl', () => {
  it.each([
    ['https://www.linkedin.com/jobs/view/12345/', '12345'],
    ['https://www.linkedin.com/jobs/view/12345?trk=x', '12345'],
    [
      'https://www.linkedin.com/jobs/search/?currentJobId=987&keywords=a',
      '987',
    ],
    [
      'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=55',
      '55',
    ],
    ['https://example.com/jobs/view/12345/', null],
    ['https://www.linkedin.com/jobs/view/abc/', null],
    ['https://www.linkedin.com/feed/?currentJobId=5', null],
    ['not a url', null],
  ])('%s', (url, id) => {
    expect(parseJobUrl(url)).toBe(id);
  });
  it('builds the view url', () => {
    expect(jobViewUrl('42')).toBe('https://www.linkedin.com/jobs/view/42/');
  });
});
