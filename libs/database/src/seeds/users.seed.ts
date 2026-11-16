import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { findAuthUserByEmail } from '../auth/index.js';
import type { Seed } from './seed.interface.js';

const users = [{ email: 'test@xapply.local' }];

/** Creates the auth user (the sign-up trigger adds its users row) or finds the existing one. */
async function ensureAuthUser(
  auth: SupabaseClient['auth']['admin'],
  email: string,
): Promise<{ id: string; created: boolean }> {
  const { data, error } = await auth.createUser({ email, email_confirm: true });
  if (!error) return { id: data.user.id, created: true };
  if (
    error.code !== 'email_exists' &&
    !/already been registered/i.test(error.message)
  ) {
    throw new Error(`Could not create auth user ${email}: ${error.message}`);
  }
  const id = (await findAuthUserByEmail(auth, email))?.id;
  if (!id)
    throw new Error(`Auth user ${email} is registered but was not listed`);
  return { id, created: false };
}

export const usersSeed: Seed = {
  name: 'users',
  async run(env, log) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        'The users seed creates auth users: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (locally: eval "$(scripts/supabase-env.sh)").',
      );
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    for (const user of users) {
      const { created } = await ensureAuthUser(supabase.auth.admin, user.email);
      log(
        created
          ? `created auth user ${user.email}`
          : `auth user ${user.email} already exists`,
      );
    }
  },
};
