// ============================================================
// GET /api/prospecting/meta-status  (admin+) — what the official number may
// send: Meta's messaging-limit tier (new people per rolling 24h, counted
// per business portfolio) and its quality rating. The campaign wizard
// uses it to cap the daily limit and to show the cost estimate in
// context. Read-only; never cached, the tier moves with quality.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getSendingLimits, tierLimit } from '@/lib/whatsapp/meta-api'

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data: config } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .eq('is_primary', true)
      .maybeSingle()
    if (!config?.phone_number_id || !config.access_token) {
      return NextResponse.json({ configured: false })
    }
    try {
      const info = await getSendingLimits({
        phoneNumberId: config.phone_number_id as string,
        accessToken: decrypt(config.access_token as string),
      })
      return NextResponse.json({
        configured: true,
        phone: info.display_phone_number ?? null,
        quality: info.quality_rating ?? null,
        tier: info.messaging_limit_tier ?? null,
        limit: tierLimit(info.messaging_limit_tier),
      })
    } catch (err) {
      // An expired token is the usual cause; the wizard says so instead of
      // letting the first send fail.
      console.warn('[prospecting/meta-status] Meta lookup failed:', err)
      return NextResponse.json({
        configured: true,
        error: err instanceof Error ? err.message.slice(0, 200) : 'meta_error',
      })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
