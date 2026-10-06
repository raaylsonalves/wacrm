// Subscription status of an account (accounts.subscription_status,
// migration 106). The database trigger is the real gate; this mirrors it
// so the UI can explain instead of failing after the click.

export const SUBSCRIPTION_STATUSES = [
  'pending',
  'active',
  'past_due',
  'canceled',
  'exempt',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(v: unknown): v is SubscriptionStatus {
  return SUBSCRIPTION_STATUSES.includes(v as SubscriptionStatus);
}

/** Paid, or released by the operator (trial / own accounts). */
export function canInviteMembers(status: SubscriptionStatus | null): boolean {
  return status === 'active' || status === 'exempt';
}

/**
 * May this account use the app at all? Not while nothing is paid
 * (`pending`) and not once a subscription has ended (`canceled`: the sweep
 * only sets it after the paid period or the grace is over). `past_due`
 * keeps access during its grace window. Unknown values fail closed.
 */
export function isAccountUsable(status: string): boolean {
  return status === 'active' || status === 'exempt' || status === 'past_due';
}
