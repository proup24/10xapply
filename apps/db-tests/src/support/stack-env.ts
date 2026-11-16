import { execFileSync } from 'node:child_process';

export type StackEnv = {
  url: string;
  publishableKey: string;
  serviceRoleKey: string;
};

const NOT_REACHABLE =
  'Supabase stack not reachable: run pnpm db:start (or set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY)';

let lastCliError: unknown;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
// 10xapply's own stack: API 55321, DB 55322. 10xjobs's stack sits on 543xx and must never be touched.
const LOCAL_PORTS = new Set(['55321', '55322']);

/**
 * The suite creates and deletes users, so it only runs against this repo's
 * local stack. The message names the host and port, never the credentials.
 */
export function assertLocal(url: string): void {
  const { hostname, port } = new URL(url);
  if (LOCAL_HOSTS.has(hostname) && LOCAL_PORTS.has(port)) return;
  throw new Error(
    `Refusing to run db-tests against ${hostname}:${port || 'default'}: the tests create users, so they only run against the local stack on 127.0.0.1 ports 55321 and 55322.`,
  );
}

function fromEnv(): StackEnv | undefined {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY } =
    process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SERVICE_ROLE_KEY)
    return undefined;
  return {
    url: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  };
}

function fromCli(): StackEnv | undefined {
  try {
    const out = execFileSync(
      'pnpm',
      ['--workspace-root', 'exec', 'supabase', 'status', '-o', 'json'],
      {
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      },
    );
    const status = JSON.parse(out) as Record<string, string | undefined>;
    const { API_URL, SERVICE_ROLE_KEY } = status;
    const publishable = status['PUBLISHABLE_KEY'] ?? status['ANON_KEY'];
    if (!API_URL || !publishable || !SERVICE_ROLE_KEY) return undefined;
    return {
      url: API_URL,
      publishableKey: publishable,
      serviceRoleKey: SERVICE_ROLE_KEY,
    };
  } catch (cause) {
    lastCliError = cause;
    return undefined;
  }
}

export function loadStackEnv(): StackEnv {
  const env = fromEnv() ?? fromCli();
  if (!env) throw new Error(NOT_REACHABLE, { cause: lastCliError });
  assertLocal(env.url);
  return env;
}
