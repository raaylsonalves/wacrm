/**
 * Structured audit log (specs/audit-log-endurecido.md). Call `audit()`
 * from a mutation route right after the mutation has actually
 * succeeded — never before, and never in place of the real write.
 *
 * Fire-and-forget by design: a failure writing the audit row must
 * never fail or roll back the mutation it's describing. The `void`
 * caller pattern below is deliberate — do NOT `await` this in a
 * request path that needs to stay fast, and do NOT let a caller wrap
 * it in a try/catch that re-throws.
 */

import { supabaseAdmin } from '@/lib/flows/admin-client';

export interface AuditEvent {
  accountId: string;
  /** Null for a system/cron-triggered event — none at this scope yet. */
  actorUserId: string | null;
  /** e.g. 'channel.created', 'member.role_changed', 'broadcast.sent'. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  /**
   * Describes the mutation only. NEVER put a token, secret, API key,
   * or message body in here — this table is deliberately readable by
   * every account member (specs/audit-log-endurecido.md's RLS
   * section), and it can never be edited or deleted once written.
   */
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Writes one audit_log row under the service-role client (the RLS
 * INSERT policy only allows service_role — see migration 065). Never
 * throws; logs to console on failure so it's visible in server logs
 * without ever being able to affect the caller's response.
 */
export async function audit(event: AuditEvent): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from('audit_log')
      .insert({
        account_id: event.accountId,
        actor_user_id: event.actorUserId,
        action: event.action,
        resource_type: event.resourceType,
        resource_id: event.resourceId ?? null,
        metadata: event.metadata ?? {},
        request_id: event.requestId ?? null,
      });
    if (error) {
      console.error('[audit] insert failed:', error.message, {
        action: event.action,
      });
    }
  } catch (err) {
    console.error('[audit] threw:', err instanceof Error ? err.message : err, {
      action: event.action,
    });
  }
}
