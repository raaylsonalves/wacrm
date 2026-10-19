/**
 * Finishes a hosted Embedded Signup (specs/whatsapp-coexistence.md) when
 * Meta's account_update PARTNER_ADDED arrives: fetch the customer's
 * business token, read the number, match it to the waiting request the
 * customer made in Settings, store the number, and — for a number that
 * stays in the WhatsApp Business app — ask once for contacts and history.
 *
 * Service role: tenancy comes from the matched whatsapp_signups row, never
 * from the webhook. Never throws; failures land on the signup row.
 */

import { randomInt } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encrypt } from './encryption';
import { registerPhoneNumber, subscribeWabaToApp } from './meta-api';
import { canAddWhatsappNumber } from '@/lib/billing/number-limit';
import {
  fetchBusinessToken,
  listCoexPhones,
  matchSignup,
  requestSmbSync,
  type CoexPhone,
  type PartnerAdded,
} from './coexistence';

/** A request older than this no longer claims a number. */
const CLAIM_WINDOW_MS = 7 * 86_400_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

interface SignupRow {
  id: string;
  account_id: string | null;
  requested_by: string | null;
  phone_digits: string | null;
}

export async function completeHostedSignup(
  db: Db,
  partner: PartnerAdded
): Promise<void> {
  const systemToken = process.env.META_SYSTEM_USER_TOKEN?.trim();
  // META_APP_SECRET may list several apps' secrets (docs/multi-waba.md);
  // the signup app's comes first.
  const appSecret = process.env.META_APP_SECRET?.split(',')[0]?.trim();
  if (!systemToken || !appSecret) {
    console.error(
      '[coexistence] META_SYSTEM_USER_TOKEN / META_APP_SECRET not set — signup left unmatched'
    );
    await recordUnmatched(db, partner, null, 'server_not_configured');
    return;
  }

  let token: string;
  let phones: CoexPhone[];
  try {
    token = await fetchBusinessToken({
      ownerBusinessId: partner.ownerBusinessId,
      systemToken,
      appSecret,
    });
    phones = await listCoexPhones({
      wabaId: partner.wabaId,
      accessToken: token,
    });
  } catch (err) {
    console.error('[coexistence] could not read the shared account:', err);
    await recordUnmatched(db, partner, null, errorText(err));
    return;
  }

  for (const phone of phones) {
    try {
      await connectPhone(db, partner, token, phone);
    } catch (err) {
      console.error('[coexistence] connect failed:', err);
    }
  }
}

async function connectPhone(
  db: Db,
  partner: PartnerAdded,
  token: string,
  phone: CoexPhone
): Promise<void> {
  const mode = phone.is_on_biz_app ? 'coexistence' : 'api';
  const display = phone.display_phone_number ?? '';

  // Meta can repeat PARTNER_ADDED: a number we already hold just gets the
  // fresh token and is marked connected again.
  const { data: existing } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('phone_number_id', phone.id)
    .maybeSingle();
  if (existing) {
    await db
      .from('whatsapp_config')
      .update({
        access_token: encrypt(token),
        waba_id: partner.wabaId,
        status: 'connected',
        health_error: null,
        onboarding_mode: mode,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return;
  }

  const { data: waiting } = await db
    .from('whatsapp_signups')
    .select('id, account_id, requested_by, phone_digits')
    .eq('status', 'waiting')
    .gte('created_at', new Date(Date.now() - CLAIM_WINDOW_MS).toISOString())
    .order('created_at', { ascending: false });
  const signup = matchSignup((waiting ?? []) as SignupRow[], display);
  if (!signup?.account_id || !signup.requested_by) {
    await recordUnmatched(db, partner, phone, 'no_waiting_request');
    return;
  }
  const ids = {
    waba_id: partner.wabaId,
    owner_business_id: partner.ownerBusinessId,
    phone_number_id: phone.id,
    display_phone_number: display,
    mode,
  };
  const fail = (error: string) =>
    db
      .from('whatsapp_signups')
      .update({ ...ids, status: 'failed', error })
      .eq('id', signup.id);

  const limit = await canAddWhatsappNumber(db, signup.account_id);
  if (!limit.allowed) {
    await fail('number_limit');
    return;
  }

  try {
    await subscribeWabaToApp({ wabaId: partner.wabaId, accessToken: token });
  } catch (err) {
    await fail(errorText(err));
    return;
  }

  // A number in the app is already registered: registering again would
  // take it out of the app. Only an API-only number registers, with a
  // fresh two-step PIN (we never need it back).
  let registrationError: string | null = null;
  if (mode === 'api') {
    try {
      await registerPhoneNumber({
        phoneNumberId: phone.id,
        accessToken: token,
        pin: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      });
    } catch (err) {
      registrationError = errorText(err);
    }
  }

  const now = new Date().toISOString();
  const { count: primaries } = await db
    .from('whatsapp_config')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', signup.account_id)
    .eq('is_primary', true);
  const { data: config, error: insertError } = await db
    .from('whatsapp_config')
    .insert({
      account_id: signup.account_id,
      user_id: signup.requested_by,
      is_primary: !primaries,
      phone_number_id: phone.id,
      waba_id: partner.wabaId,
      access_token: encrypt(token),
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : now,
      registered_at: registrationError ? null : now,
      subscribed_apps_at: now,
      last_registration_error: registrationError,
      display_phone_number: display || null,
      label: phone.verified_name ?? null,
      onboarding_mode: mode,
      health_checked_at: now,
    })
    .select('id')
    .single();
  if (insertError || !config) {
    await fail(insertError?.message ?? 'insert_failed');
    return;
  }

  await db
    .from('whatsapp_signups')
    .update({
      ...ids,
      status: 'connected',
      error: registrationError,
      whatsapp_config_id: config.id,
    })
    .eq('id', signup.id);

  if (mode === 'coexistence')
    await startCoexistenceSync(db, config.id as string, phone.id, token);
}

/**
 * The one-shot contacts and history syncs. Meta allows each once, within
 * 24 h of onboarding; the request ids are kept for Meta support.
 */
export async function startCoexistenceSync(
  db: Db,
  configId: string,
  phoneNumberId: string,
  token: string
) {
  const sync: Record<string, string> = {};
  for (const [key, syncType] of [
    ['contacts', 'smb_app_state_sync'],
    ['history', 'history'],
  ] as const) {
    try {
      sync[key] = await requestSmbSync({
        phoneNumberId,
        accessToken: token,
        syncType,
      });
    } catch (err) {
      sync[`${key}_error`] = errorText(err);
    }
  }
  await db
    .from('whatsapp_config')
    .update({
      coexistence_sync: sync,
      coexistence_synced_at: new Date().toISOString(),
    })
    .eq('id', configId);
}

/** A connection no request claims: kept for the platform to sort out. */
async function recordUnmatched(
  db: Db,
  partner: PartnerAdded,
  phone: CoexPhone | null,
  error: string
) {
  await db.from('whatsapp_signups').insert({
    status: 'unmatched',
    waba_id: partner.wabaId,
    owner_business_id: partner.ownerBusinessId,
    phone_number_id: phone?.id ?? null,
    display_phone_number: phone?.display_phone_number ?? null,
    mode: phone?.is_on_biz_app ? 'coexistence' : 'api',
    error,
  });
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
