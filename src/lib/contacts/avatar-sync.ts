// ============================================================
// Keep contact profile photos (ported in spirit from deskcomm's
// contact-avatars cron).
//
//  - Only contacts talking on a WAHA number: the official Cloud API has no
//    endpoint for a customer's profile photo.
//  - Out of the webhook's hot path: a sweep on the automations cron, a few
//    contacts per run, never-looked-up first, then refreshed every 7 days.
//  - The FILE is stored, not WhatsApp's URL: that URL is signed and expires
//    in days, so storing it would make every avatar vanish silently.
//  - Anonymized contacts (LGPD) are never looked up again — a refresh would
//    bring back the personal data that was erased. The write repeats the
//    filter to close the race with an anonymization running meanwhile.
//  - Every contact looked at is stamped, photo or not, so one without a
//    photo isn't retried on every run.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getWahaProfilePictureUrl, toWahaChatId } from '@/lib/whatsapp/waha-api'
import { buildMediaPath } from '@/lib/storage/upload-media'

const SCAN_LIMIT = 25
const REFRESH_AFTER_DAYS = 7
const MAX_BYTES = 2 * 1024 * 1024
const BUCKET = 'chat-media'

interface Row {
  contact_id: string
  whatsapp_channel_id: string
  account_id: string
  contact: {
    id: string
    phone: string | null
    anonymized_at: string | null
    avatar_updated_at: string | null
  } | null
}

export interface AvatarSweep {
  looked: number
  updated: number
  none: number
  failed: number
}

export async function syncContactAvatars(
  db: SupabaseClient,
  now: Date = new Date(),
  deps: { fetchImage?: typeof fetch; lookup?: typeof getWahaProfilePictureUrl } = {},
): Promise<AvatarSweep> {
  const fetchImage = deps.fetchImage ?? fetch
  const lookup = deps.lookup ?? getWahaProfilePictureUrl
  const cutoff = new Date(now.getTime() - REFRESH_AFTER_DAYS * 86_400_000).toISOString()
  const out: AvatarSweep = { looked: 0, updated: 0, none: 0, failed: 0 }

  // Plain query, filtered here: embedded-resource filters are easy to get
  // silently wrong in PostgREST, and this set is small.
  const { data } = await db
    .from('conversations')
    .select('contact_id, whatsapp_channel_id, account_id, contact:contacts(id, phone, anonymized_at, avatar_updated_at)')
    .not('whatsapp_channel_id', 'is', null)
    .order('last_message_at', { ascending: false })
    .limit(500)
  const due = (c: Row['contact']) =>
    !!c && !c.anonymized_at && (!c.avatar_updated_at || c.avatar_updated_at < cutoff)
  const rows = ((data ?? []) as unknown as Row[])
    .filter((r) => due(r.contact))
    // Never-looked-up first: a missing face bothers more than an old one.
    .sort((a, b) => Number(!!a.contact?.avatar_updated_at) - Number(!!b.contact?.avatar_updated_at))
    .slice(0, SCAN_LIMIT)
  const channels = new Map<string, { base: string; key: string; session: string; ok: boolean } | null>()

  for (const r of rows) {
    const c = r.contact
    if (!c) continue
    out.looked++
    const stamp = async (avatarUrl?: string) => {
      await db
        .from('contacts')
        .update({
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
          avatar_updated_at: now.toISOString(),
        })
        .eq('id', c.id)
        .eq('account_id', r.account_id)
        .is('anonymized_at', null)
    }

    if (!channels.has(r.whatsapp_channel_id)) {
      const { data: ch } = await db
        .from('whatsapp_waha_channels')
        .select('waha_base_url, waha_api_key, waha_session_name, status')
        .eq('id', r.whatsapp_channel_id)
        .eq('account_id', r.account_id)
        .maybeSingle()
      let entry: { base: string; key: string; session: string; ok: boolean } | null = null
      if (ch) {
        try {
          entry = {
            base: ch.waha_base_url,
            key: decrypt(ch.waha_api_key),
            session: ch.waha_session_name,
            ok: ch.status === 'connected',
          }
        } catch {
          entry = null
        }
      }
      channels.set(r.whatsapp_channel_id, entry)
    }
    const ch = channels.get(r.whatsapp_channel_id)
    // A disconnected number: try again next run rather than stamp "no photo".
    if (ch && !ch.ok) continue
    if (!ch || !c.phone) {
      await stamp()
      out.none++
      continue
    }

    try {
      const url = await lookup(ch.base, ch.key, ch.session, toWahaChatId(c.phone))
      if (!url) {
        await stamp()
        out.none++
        continue
      }
      const img = await fetchImage(url, { signal: AbortSignal.timeout(10_000) })
      const buf = img.ok ? new Uint8Array(await img.arrayBuffer()) : new Uint8Array()
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        await stamp()
        out.failed++
        continue
      }
      // Same path every time (upsert): a refreshed photo replaces the old one.
      const path = buildMediaPath(r.account_id, `avatar-${c.id}.jpg`, null, 'avatars')
      const { error } = await db.storage
        .from(BUCKET)
        .upload(path, buf, { contentType: 'image/jpeg', cacheControl: '3600', upsert: true })
      if (error) {
        await stamp()
        out.failed++
        continue
      }
      const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path)
      // Version suffix so a browser cache doesn't keep the old face.
      await stamp(`${pub.publicUrl}?v=${now.getTime()}`)
      out.updated++
    } catch (err) {
      console.warn('[avatars] lookup failed:', err instanceof Error ? err.message : err)
      await stamp()
      out.failed++
    }
  }
  return out
}
