// ============================================================
// Follow-up sequences — the database side (specs/followup-sequences.md).
//
// Used by the engine (send-time guard, enrollment bookkeeping) and by
// the sweep. Service-role only: every query is scoped by the
// enrollment's own account, never by anything caller-supplied.
// ============================================================

import { supabaseAdmin } from './admin-client'
import {
  FOLLOWUP_CAP_WINDOW_MS,
  FOLLOWUP_WEEKLY_CAP,
  decideFollowupStep,
  parseSilenceConfig,
  type FollowupOutcome,
  type GuardVerdict,
} from './followup-logic'

/**
 * Re-read the world for an enrollment and decide whether its next send
 * goes out. On a "stop" the enrollment is ended here (once), so callers
 * only have to stop executing.
 *
 * Fails CLOSED: a lookup error or a missing row means "don't send" —
 * a follow-up is the one message nobody is waiting for, so skipping it
 * on doubt costs a nudge, sending it on doubt costs a customer.
 */
export async function guardFollowupSend(args: {
  enrollmentId: string
  stepIsTemplate: boolean
  now?: Date
}): Promise<GuardVerdict> {
  const db = supabaseAdmin()
  const now = args.now ?? new Date()

  const { data: enr, error: enrErr } = await db
    .from('followup_enrollments')
    .select('id, account_id, automation_id, conversation_id, contact_id, episode_at, status')
    .eq('id', args.enrollmentId)
    .maybeSingle()
  if (enrErr || !enr) return { kind: 'stop', outcome: null }
  if (enr.status !== 'active') return { kind: 'stop', outcome: null }

  const [{ data: conv }, { data: contact }, { data: automation }, sends] = await Promise.all([
    db
      .from('conversations')
      .select(
        'status, snoozed_until, last_customer_message_at, assigned_agent_id, ai_autoreply_disabled, whatsapp_channel_id',
      )
      .eq('id', enr.conversation_id)
      .eq('account_id', enr.account_id)
      .maybeSingle(),
    db
      .from('contacts')
      .select('opted_out_at')
      .eq('id', enr.contact_id)
      .eq('account_id', enr.account_id)
      .maybeSingle(),
    db
      .from('automations')
      .select('trigger_config')
      .eq('id', enr.automation_id)
      .eq('account_id', enr.account_id)
      .maybeSingle(),
    db
      .from('followup_sends')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', enr.contact_id)
      .eq('account_id', enr.account_id)
      .gte('sent_at', new Date(now.getTime() - FOLLOWUP_CAP_WINDOW_MS).toISOString()),
  ])

  if (!conv || !contact) {
    await endEnrollment(enr.id, 'cancelled', 'not_deliverable')
    return { kind: 'stop', outcome: 'not_deliverable' }
  }
  const cfg = parseSilenceConfig(automation?.trigger_config)

  const verdict = decideFollowupStep({
    now,
    enrollmentActive: true,
    episodeAt: new Date(enr.episode_at as string),
    lastCustomerMessageAt: conv.last_customer_message_at
      ? new Date(conv.last_customer_message_at as string)
      : null,
    contactOptedOut: !!contact.opted_out_at,
    conversationStatus: conv.status as string,
    snoozedUntil: conv.snoozed_until ? new Date(conv.snoozed_until as string) : null,
    // A person owns the thread: assigned to someone, or — for a sequence
    // that follows up AI conversations — the AI was paused / handed off
    // with nobody assigned yet (review 2026-10, A11).
    humanOwnsAndPolicyCancels:
      (!!conv.assigned_agent_id ||
        ((cfg?.audience ?? 'ai_conversations') === 'ai_conversations' &&
          !!conv.ai_autoreply_disabled)) &&
      (cfg?.handoff_policy ?? 'cancel') === 'cancel',
    isCloudApi: conv.whatsapp_channel_id == null,
    stepIsTemplate: args.stepIsTemplate,
    sendsInCapWindow: sends.count ?? 0,
    weeklyCap: FOLLOWUP_WEEKLY_CAP,
    window: cfg?.send_window,
  })

  if (verdict.kind === 'stop' && verdict.outcome) {
    await endEnrollment(enr.id, 'cancelled', verdict.outcome)
  }
  return verdict
}

/** Is this enrollment still live? Used by the cron before resuming a wait
 *  it already claimed — the race the send-time guard would also catch,
 *  refused one step earlier so the log stays clean. */
export async function isEnrollmentActive(enrollmentId: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('followup_enrollments')
    .select('status')
    .eq('id', enrollmentId)
    .maybeSingle()
  return data?.status === 'active'
}

/** End an enrollment once (`WHERE status = 'active'`) and kill any wait it
 *  still has parked. Idempotent: a second call is a no-op. */
export async function endEnrollment(
  enrollmentId: string,
  status: 'completed' | 'cancelled',
  outcome: FollowupOutcome,
): Promise<void> {
  const db = supabaseAdmin()
  const { error } = await db
    .from('followup_enrollments')
    .update({ status, outcome, ended_at: new Date().toISOString() })
    .eq('id', enrollmentId)
    .eq('status', 'active')
  if (error) {
    console.error('[followup] endEnrollment failed:', error.message)
    return
  }
  await db
    .from('automation_pending_executions')
    .update({ status: 'cancelled' })
    .eq('enrollment_id', enrollmentId)
    .eq('status', 'pending')
}

/** Count a delivered follow-up message: feeds the cross-sequence cap and
 *  the enrollment's own `steps_sent`. Best-effort — a bookkeeping failure
 *  must not turn a delivered message into a failed step. */
export async function recordFollowupSend(args: {
  enrollmentId: string
  accountId: string
  contactId: string
}): Promise<void> {
  const db = supabaseAdmin()
  try {
    await db.from('followup_sends').insert({
      account_id: args.accountId,
      enrollment_id: args.enrollmentId,
      contact_id: args.contactId,
    })
    const { data } = await db
      .from('followup_enrollments')
      .select('steps_sent')
      .eq('id', args.enrollmentId)
      .maybeSingle()
    await db
      .from('followup_enrollments')
      .update({ steps_sent: (data?.steps_sent ?? 0) + 1 })
      .eq('id', args.enrollmentId)
  } catch (err) {
    console.warn('[followup] recordFollowupSend failed:', err)
  }
}
