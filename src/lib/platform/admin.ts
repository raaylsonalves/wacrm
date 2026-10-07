// The platform (Nordia) runs this CRM for paying customers. Its own
// account's admins see every subscriber's billing in the subscribers panel
// — billing only, never the customer's conversations or contacts.
//
// Which account is the platform: PLATFORM_ACCOUNT_ID, falling back to the
// landing's lead account (the same Nordia account in practice).

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { hasMinRole, isAccountRole } from '@/lib/auth/roles';

export function platformAccountId(): string | null {
  return (
    process.env.PLATFORM_ACCOUNT_ID ||
    process.env.LANDING_LEAD_ACCOUNT_ID ||
    null
  );
}

/**
 * True when the user is an admin (or owner) of the platform account,
 * judged by their HOME account: an operator currently inside a client's
 * account still counts, and a client's own admin never does.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const platform = platformAccountId();
  if (!platform) return false;
  const db = supabaseAdmin();
  const { data: op } = await db
    .from('platform_operators')
    .select('home_account_id, home_role')
    .eq('user_id', userId)
    .maybeSingle();
  if (op) {
    return (
      op.home_account_id === platform &&
      isAccountRole(op.home_role) &&
      hasMinRole(op.home_role, 'admin')
    );
  }
  const { data: profile } = await db
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', userId)
    .maybeSingle();
  return (
    profile?.account_id === platform &&
    isAccountRole(profile.account_role) &&
    hasMinRole(profile.account_role, 'admin')
  );
}
