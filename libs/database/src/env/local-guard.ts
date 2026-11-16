/** Hosts of the local Supabase CLI stack. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/**
 * 10xapply's own local stack: API on 55321, DB on 55322 (`supabase/config.toml`).
 * 10xjobs's stack runs on the same machine on 543xx and must never be touched,
 * so a local host on any other port, or with no port, is refused too.
 */
const LOCAL_PORTS = new Set(['55321', '55322']);

/**
 * @description Returns the first target of `url` that is not 10xapply's local
 * stack, or undefined when every target is. A non-local host comes back as
 * `{ host }`; a local host on another port as `{ port: 'host:port' }`. Besides
 * the authority, pg-connection-string and libpq let `host`, `hostaddr` and
 * `port` query parameters override it, so those count too (socket paths
 * included). Unparseable URLs yield the host `<unparseable>`.
 */
function foreignTargetOf(
  url: string,
): { host: string } | { port: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: '<unparseable>' };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const hosts = [hostname];
  for (const key of ['host', 'hostaddr']) {
    for (const value of parsed.searchParams.getAll(key)) {
      hosts.push(...value.split(','));
    }
  }
  const remote = hosts.find((host) => !LOCAL_HOSTS.has(host));
  if (remote !== undefined) return { host: remote };
  const ports = [parsed.port];
  for (const value of parsed.searchParams.getAll('port')) {
    ports.push(...value.split(','));
  }
  const port = ports.find((value) => !LOCAL_PORTS.has(value));
  if (port !== undefined) return { port: `${hostname}:${port || 'default'}` };
  return undefined;
}

/**
 * @description True when every target of `url` is 10xapply's local Supabase
 * stack: `127.0.0.1`, `localhost` or `::1`, on port 55321 or 55322.
 * Unparseable URLs are not local.
 */
export function isLocalUrl(url: string): boolean {
  return foreignTargetOf(url) === undefined;
}

/**
 * @description Copies the remote opt-in out of `env`. Call it before any env
 * file is loaded, so `XAPPLY_ALLOW_REMOTE_DB=1` in a `.env` cannot disable the
 * guard; only the shell, CI or an inline assignment can.
 */
export function captureRemoteOptIn(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { XAPPLY_ALLOW_REMOTE_DB: env.XAPPLY_ALLOW_REMOTE_DB };
}

/**
 * @description Throws unless every defined URL is 10xapply's local stack, or
 * `XAPPLY_ALLOW_REMOTE_DB=1` is set. The message names the variable, the host
 * and (for a local host) the port only, never the password or the full URL.
 */
export function assertLocalDatabase(
  urls: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv,
): void {
  if (env.XAPPLY_ALLOW_REMOTE_DB === '1') return;
  for (const [name, url] of Object.entries(urls)) {
    if (url === undefined) continue;
    const target = foreignTargetOf(url);
    if (target === undefined) continue;
    throw new Error(
      'host' in target
        ? `Refusing to use ${name} at non-local host ${target.host}. Set XAPPLY_ALLOW_REMOTE_DB=1 to allow it.`
        : `Refusing to use ${name} at ${target.port}: 10xapply's local stack is on ports 55321 and 55322 only. Set XAPPLY_ALLOW_REMOTE_DB=1 to allow it.`,
    );
  }
}
