const KEY_PREFIX = 'linkedin-job:';

/**
 * The LinkedIn job id of a match, or null when it is not an Easy Apply job.
 * A `linkedin-job:` key gives the id; any other key kind gives null; only an
 * absent key falls back to the posting URL.
 */
export function linkedinJobId(
  jobKey: string | null,
  postingUrl: string,
): string | null {
  if (jobKey !== null) {
    if (!jobKey.startsWith(KEY_PREFIX)) return null;
    const id = jobKey.slice(KEY_PREFIX.length);
    return /^\d+$/.test(id) ? id : null;
  }
  return parseJobUrl(postingUrl);
}

// Copied from apps/runner/src/linkedin/job-url.ts (parseJobUrl); apps do not
// import across each other. Keep the two in step.
function parseJobUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'linkedin.com' && !u.hostname.endsWith('.linkedin.com')) {
    return null;
  }
  const view = /^\/jobs\/view\/(\d+)(?:\/|$)/.exec(u.pathname);
  if (view) return view[1] ?? null;
  if (u.pathname.startsWith('/jobs/')) {
    const id = u.searchParams.get('currentJobId');
    if (id !== null && /^\d+$/.test(id)) return id;
  }
  return null;
}
