/** The job id from /jobs/view/<id> or a currentJobId query on a LinkedIn jobs URL. */
export function parseJobUrl(url: string): string | null {
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

export function jobViewUrl(id: string): string {
  return `https://www.linkedin.com/jobs/view/${id}/`;
}
