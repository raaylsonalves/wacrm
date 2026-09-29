import { describe, it, expect } from 'vitest'
import {
  buildApproachPrompt,
  failureScope,
  isInSendingWindow,
  nextSendAt,
  nextWindowOpening,
  optOutLine,
  parseCampaignConfig,
  renderTemplateParams,
  warmupCeiling,
} from './logic'

const U = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const base = {
  channel_kind: 'waha',
  channel_id: U(1),
  agent_id: U(2),
  pipeline_id: U(3),
  entry_stage_id: U(4),
  qualified_stage_id: U(5),
  instruction: 'Oferecemos sites para oficinas.',
  criteria: 'Tem oficina própria e quer vender online.',
  legal_basis_ref: 'Oficinas com contato público no Google.',
}

describe('parseCampaignConfig', () => {
  it('accepts a WAHA campaign and applies defaults', () => {
    const r = parseCampaignConfig(base)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config).toMatchObject({ daily_limit: 10, interval_minutes: 15, timezone: 'America/Sao_Paulo' })
  })
  it('a Cloud campaign needs a template, not a channel id', () => {
    expect(parseCampaignConfig({ ...base, channel_kind: 'cloud', channel_id: null })).toEqual({
      ok: false,
      error: 'template_required',
    })
    const r = parseCampaignConfig({ ...base, channel_kind: 'cloud', channel_id: null, template_name: 'ola', instruction: '' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.channel_id).toBeNull()
  })
  it.each([
    [{ entry_stage_id: U(5) }, 'stages_must_differ'],
    [{ legal_basis_ref: 'x' }, 'legal_basis_required'],
    [{ criteria: '' }, 'criteria_required'],
    [{ channel_kind: 'sms' }, 'channel_required'],
    [{ window_start_hour: 18, window_end_hour: 9 }, 'window_invalid'],
  ])('rejects %j', (patch, error) => {
    expect(parseCampaignConfig({ ...base, ...patch })).toEqual({ ok: false, error })
  })
  it('clamps limits', () => {
    const r = parseCampaignConfig({ ...base, daily_limit: 999, interval_minutes: 1 })
    if (r.ok) expect([r.config.daily_limit, r.config.interval_minutes]).toEqual([50, 5])
  })
})

describe('sending window', () => {
  const c = { window_start_hour: 9, window_end_hour: 18, weekdays: [1, 2, 3, 4, 5], timezone: 'America/Sao_Paulo' }
  it('Tuesday 10:00 in São Paulo is inside; 20:00 and Sunday are not', () => {
    expect(isInSendingWindow(new Date('2026-09-29T13:00:00Z'), c)).toBe(true) // 10:00 BRT
    expect(isInSendingWindow(new Date('2026-09-29T23:00:00Z'), c)).toBe(false) // 20:00 BRT
    expect(isInSendingWindow(new Date('2026-09-27T13:00:00Z'), c)).toBe(false) // Sunday
  })
  it('the next opening after Friday night is Monday 09:00', () => {
    const next = nextWindowOpening(new Date('2026-10-02T23:30:00Z'), c) // Fri 20:30 BRT
    expect(next.toISOString()).toBe('2026-10-05T12:00:00.000Z') // Mon 09:00 BRT
  })
})

describe('pacing', () => {
  it('warm-up grows with the WAHA number age; the Cloud API has none', () => {
    const now = new Date('2026-09-29T12:00:00Z')
    expect(warmupCeiling('waha', '2026-09-28T12:00:00Z', now)).toBe(5)
    expect(warmupCeiling('waha', '2026-09-20T12:00:00Z', now)).toBe(20)
    expect(warmupCeiling('waha', '2026-01-01T00:00:00Z', now)).toBe(50)
    expect(warmupCeiling('cloud', null, now)).toBe(Infinity)
  })
  it('jitter only delays, never below the interval', () => {
    const now = new Date('2026-09-29T12:00:00Z')
    expect(nextSendAt(now, 15, 0).getTime() - now.getTime()).toBe(15 * 60_000)
    expect(nextSendAt(now, 15, 1).getTime() - now.getTime()).toBe(22.5 * 60_000)
  })
})

describe('message content', () => {
  it('template variables read the contact, empty ones get a placeholder', () => {
    expect(
      renderTemplateParams(['{{first_name}}', 'company', 'texto fixo'], { name: 'Ana Souza', company: null }),
    ).toEqual(['Ana', '-', 'texto fixo'])
  })
  it('opt-out line follows the locale', () => {
    expect(optOutLine('pt')).toContain('SAIR')
    expect(optOutLine('xx')).toContain('STOP')
  })
  it('the approach prompt forbids pretending the lead asked', () => {
    const p = buildApproachPrompt({ instruction: 'x', criteria: 'y', contact: { name: 'Ana', company: null }, businessContext: null })
    expect(p).toContain('NEVER claim the person filled a form')
  })
  it('failure scope: bad destination is per-candidate, unknown stops the campaign', () => {
    expect(failureScope('contact_opted_out')).toBe('candidate')
    expect(failureScope('waha_channel_not_found')).toBe('campaign')
    expect(failureScope('something_new')).toBe('campaign')
  })
})

describe('follow-up config', () => {
  it('defaults off; when on, clamps days and touches', () => {
    const off = parseCampaignConfig(base)
    if (off.ok) expect(off.config.followup_enabled).toBe(false)
    const on = parseCampaignConfig({ ...base, followup_enabled: true, followup_after_days: 99, followup_max: 5 })
    if (on.ok) expect([on.config.followup_after_days, on.config.followup_max]).toEqual([14, 2])
  })
  it('the official API needs a follow-up template (past 24h only templates go out)', () => {
    expect(
      parseCampaignConfig({ ...base, channel_kind: 'cloud', channel_id: null, template_name: 't', followup_enabled: true }),
    ).toEqual({ ok: false, error: 'followup_template_required' })
  })
  it('the last touch says it will not insist', async () => {
    const { buildFollowupPrompt } = await import('./logic')
    const p = buildFollowupPrompt({ instruction: 'x', contact: { name: null, company: null }, previous: 'oi', touch: 2, businessContext: null })
    expect(p).toContain('LAST message')
  })
})
