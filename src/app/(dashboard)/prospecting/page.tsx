'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Pause,
  Play,
  Plus,
  Target,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useCan } from '@/hooks/use-can';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SkeletonList } from '@/components/ui/skeleton';

interface Funnel {
  total: number;
  queued: number;
  sent: number;
  replied: number;
  qualified: number;
  failed: number;
  skipped: number;
  opted_out: number;
  followed_up?: number;
}
interface Lead {
  id: string;
  status: string;
  error: string | null;
  conversation_id: string | null;
  sent_at: string | null;
  replied_at: string | null;
  qualified_at: string | null;
  opted_out_at: string | null;
  followups_sent: number;
  /** From the contact's "nicho:" tag, when the list was split by niche. */
  niche: string | null;
  contact: {
    name: string | null;
    phone: string;
    company: string | null;
  } | null;
}
interface Campaign {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
  config: {
    channel_kind: 'waha' | 'cloud';
    template_name?: string | null;
    cost_per_message?: number | null;
  };
  error: string | null;
  next_send_at: string;
  created_at: string;
  funnel: Funnel | null;
}

// Failed leads store "code · provider message"; translate the code and
// keep the provider's words (e.g. Meta's "(#131005) Access denied").
function reasonText(t: ReturnType<typeof useTranslations>, error: string) {
  const [code, ...rest] = error.split(' · ');
  const label = t.has(`reasons.${code}`) ? t(`reasons.${code}`) : code;
  return rest.length ? `${label} — ${rest.join(' · ')}` : label;
}

const STATUS_TONE: Record<Campaign['status'], string> = {
  draft: 'bg-muted text-muted-foreground',
  running: 'bg-tone-salmon-soft text-tone-salmon-ink',
  paused: 'bg-tone-blue-soft text-tone-blue-ink',
  completed: 'bg-tone-mint-soft text-tone-mint-ink',
  cancelled: 'bg-muted text-muted-foreground',
};
const LEAD_TONE: Record<string, string> = {
  queued: 'bg-muted text-muted-foreground',
  sent: 'bg-tone-blue-soft text-tone-blue-ink',
  replied: 'bg-tone-salmon-soft text-tone-salmon-ink',
  qualified: 'bg-tone-mint-soft text-tone-mint-ink',
  opted_out: 'bg-tone-pink-soft text-tone-pink-ink',
  skipped: 'bg-muted text-muted-foreground',
  failed: 'bg-tone-pink-soft text-tone-pink-ink',
};

function pct(n: number, of: number) {
  return of ? Math.round((n / of) * 100) : 0;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-card rounded-[20px] border px-4 py-3">
      <div className="text-muted-foreground truncate text-xs font-semibold">
        {label}
      </div>
      <div className="text-xl font-extrabold tabular-nums">{value}</div>
    </div>
  );
}

// One funnel step: count, share of the leads, and a bar in its tone.
function Step({
  label,
  n,
  of,
  color,
}: {
  label: string;
  n: number;
  of: number;
  color: string;
}) {
  const p = pct(n, of);
  return (
    <div className="min-w-0 flex-1">
      <div className="text-muted-foreground flex items-baseline justify-between gap-2 text-[11.5px] font-semibold">
        <span className="truncate">{label}</span>
        <span className="text-foreground tabular-nums">
          {n} <span className="text-muted-foreground font-medium">· {p}%</span>
        </span>
      </div>
      <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${color}`}
          style={{ width: `${p}%` }}
        />
      </div>
    </div>
  );
}
/**
 * Prospecting campaigns (specs/prospecting-csv-import.md, part B): one list,
 * one agent, one number — WAHA (the agent writes each approach) or the
 * official API (an approved template opens the conversation). The funnel
 * is counted from what happened: sent → replied → qualified.
 */
export default function ProspectingPage() {
  const t = useTranslations('Prospecting');
  const canManage = useCan('edit-settings');
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    fetch('/api/prospecting/campaigns', { cache: 'no-store' })
      .then(async (res) => ({
        ok: res.ok,
        data: await res.json().catch(() => ({})),
      }))
      .then(
        ({ ok, data }) =>
          alive && setCampaigns(ok ? (data.campaigns ?? []) : [])
      )
      .catch(() => alive && setCampaigns([]));
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // The cron sends in the background; while a campaign runs, keep the
  // funnel and the lead list current instead of showing the state from
  // when the page opened.
  const anyRunning = campaigns?.some((c) => c.status === 'running') ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [anyRunning, load]);

  // A campaign that already sent everything is "completed", but its leads
  // keep replying and getting qualified. Refresh (debounced) on every new
  // message; RLS scopes the stream to this account.
  const hasCampaigns = (campaigns?.length ?? 0) > 0;
  useEffect(() => {
    if (!hasCampaigns) return;
    const supabase = createClient();
    const timers: number[] = [];
    const channel = supabase
      .channel('prospecting:replies')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        () => {
          // Any message: the customer's reply marks "replied", and the
          // agent's answer lands right after it called qualify_lead.
          window.clearTimeout(timers.pop());
          timers.push(window.setTimeout(load, 1_500));
        }
      )
      .subscribe();
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      void supabase.removeChannel(channel);
    };
  }, [hasCampaigns, load]);

  async function act(id: string, action: 'pause' | 'resume' | 'cancel') {
    const res = await fetch(`/api/prospecting/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      toast.error(
        t.has(`errors.${data.error}`)
          ? t(`errors.${data.error}`)
          : t('errors.generic')
      );
    load();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-[26px] leading-tight font-bold tracking-[-0.02em] lg:text-[28px]">
            {t('title')}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            {t('subtitle')}
          </p>
        </div>
        {canManage && (
          <Button
            nativeButton={false}
            render={<Link href="/prospecting/new" />}
          >
            <Plus className="size-4" />
            {t('new')}
          </Button>
        )}
      </div>

      {campaigns === null ? (
        <SkeletonList rows={3} />
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <Target className="size-8 opacity-40" />
            <p>{t('empty')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <Summary campaigns={campaigns} t={t} />
          {campaigns.map((c) => (
            <CampaignCard
              key={c.id}
              c={c}
              version={reloadKey}
              canManage={canManage}
              onAct={act}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Summary({
  campaigns,
  t,
}: {
  campaigns: Campaign[];
  t: ReturnType<typeof useTranslations>;
}) {
  const active = campaigns.filter(
    (c) => c.status === 'running' || c.status === 'paused'
  ).length;
  const sent = campaigns.reduce((a, c) => a + (c.funnel?.sent ?? 0), 0);
  const replied = campaigns.reduce((a, c) => a + (c.funnel?.replied ?? 0), 0);
  const qualified = campaigns.reduce(
    (a, c) => a + (c.funnel?.qualified ?? 0),
    0
  );
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <Stat label={t('stats.active')} value={String(active)} />
      <Stat label={t('funnel.sent')} value={String(sent)} />
      <Stat label={t('stats.replyRate')} value={`${pct(replied, sent)}%`} />
      <Stat label={t('funnel.qualified')} value={String(qualified)} />
    </div>
  );
}

function CampaignCard({
  c,
  version,
  canManage,
  onAct,
  t,
}: {
  c: Campaign;
  version: number;
  canManage: boolean;
  onAct: (id: string, action: 'pause' | 'resume' | 'cancel') => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const f = c.funnel;
  const steps: [string, number][] = f
    ? [
        [t('funnel.leads'), f.total - f.skipped],
        [t('funnel.sent'), f.sent],
        [t('funnel.replied'), f.replied],
        [t('funnel.qualified'), f.qualified],
      ]
    : [];
  const leads = steps[0]?.[1] ?? 0;
  const live = c.status === 'running';
  return (
    <div className="border-border bg-card space-y-4 rounded-[22px] border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-tone-lilac-soft text-tone-lilac-ink flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Target className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-bold">{c.name}</span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_TONE[c.status]}`}
            >
              {live && (
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-current" />
                </span>
              )}
              {t(`status.${c.status}`)}
            </span>
          </div>
          <p className="text-muted-foreground truncate text-xs">
            {t(`channel.${c.config.channel_kind}`)}
            {c.config.template_name && ` · ${c.config.template_name}`}
            {' · '}
            {new Date(c.created_at).toLocaleDateString()}
          </p>
          {c.error && (
            <p className="text-tone-pink-ink mt-1 text-xs">
              {t.has(`errors.${c.error}`) ? t(`errors.${c.error}`) : c.error}
            </p>
          )}
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-1.5">
            {c.status === 'running' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAct(c.id, 'pause')}
              >
                <Pause className="size-3.5" />
                {t('pause')}
              </Button>
            )}
            {c.status === 'paused' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAct(c.id, 'resume')}
              >
                <Play className="size-3.5" />
                {t('resume')}
              </Button>
            )}
            {(c.status === 'running' || c.status === 'paused') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onAct(c.id, 'cancel')}
              >
                <X className="size-3.5" />
                {t('cancel')}
              </Button>
            )}
          </div>
        )}
      </div>
      {f && (
        <>
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
            <div className="shrink-0">
              <div className="text-muted-foreground text-[11.5px] font-semibold">
                {t('funnel.leads')}
              </div>
              <div className="text-sm font-extrabold tabular-nums">{leads}</div>
            </div>
            <Step
              label={t('funnel.sent')}
              n={f.sent}
              of={leads}
              color="bg-tone-blue"
            />
            <Step
              label={t('funnel.replied')}
              n={f.replied}
              of={leads}
              color="bg-tone-salmon"
            />
            <Step
              label={t('funnel.qualified')}
              n={f.qualified}
              of={leads}
              color="bg-tone-mint"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              {t('funnel.details', {
                queued: f.queued,
                failed: f.failed,
                skipped: f.skipped,
                optedOut: f.opted_out,
              })}
              {(f.followed_up ?? 0) > 0 &&
                ` · ${t('funnel.followedUp', { count: f.followed_up ?? 0 })}`}
            </p>
            {c.config.channel_kind === 'cloud' && c.config.cost_per_message ? (
              <p className="text-muted-foreground text-xs">
                {t('funnel.spent', {
                  amount: (
                    (f.sent + (f.followed_up ?? 0)) *
                    c.config.cost_per_message
                  ).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  }),
                })}
              </p>
            ) : null}
          </div>
          <LeadList campaignId={c.id} version={version} t={t} />
        </>
      )}
    </div>
  );
}

/** What happened to each lead of a campaign, loaded on demand. */
function LeadList({
  campaignId,
  version,
  t,
}: {
  campaignId: string;
  version: number;
  t: ReturnType<typeof useTranslations>;
}) {
  const [open, setOpen] = useState(false);
  const [leads, setLeads] = useState<Lead[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(`/api/prospecting/campaigns/${campaignId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { leads: [] }))
      .then((d) => alive && setLeads(d.leads ?? []))
      .catch(() => alive && setLeads([]));
    return () => {
      alive = false;
    };
  }, [open, version, campaignId]);

  const stageOf = (l: Lead) =>
    l.qualified_at
      ? 'qualified'
      : l.opted_out_at
        ? 'opted_out'
        : l.replied_at
          ? 'replied'
          : l.sent_at
            ? 'sent'
            : l.status === 'skipped' || l.status === 'failed'
              ? l.status
              : 'queued';
  const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString() : '—';

  // Funnel per niche, when the list was split by one.
  const byNiche = useMemo(() => {
    const m = new Map<
      string,
      { leads: number; sent: number; replied: number; qualified: number }
    >();
    for (const l of leads ?? []) {
      if (!l.niche) continue;
      const r = m.get(l.niche) ?? {
        leads: 0,
        sent: 0,
        replied: 0,
        qualified: 0,
      };
      r.leads++;
      if (l.sent_at) r.sent++;
      if (l.replied_at) r.replied++;
      if (l.qualified_at) r.qualified++;
      m.set(l.niche, r);
    }
    return [...m.entries()].sort((a, b) => b[1].leads - a[1].leads);
  }, [leads]);

  return (
    <div>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronUp className="size-3.5" />
        ) : (
          <ChevronDown className="size-3.5" />
        )}
        {t('leads.toggle')}
      </Button>
      {open &&
        (leads === null ? (
          <Loader2 className="text-muted-foreground mx-auto size-4 animate-spin" />
        ) : (
          <div className="mt-2 space-y-3">
            {byNiche.length > 1 && (
              <div className="space-y-2 rounded-xl border p-3">
                <p className="text-xs font-bold">{t('leads.byNiche')}</p>
                {byNiche.map(([niche, r]) => (
                  <div
                    key={niche}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-3 text-xs"
                  >
                    <span className="truncate font-semibold">{niche}</span>
                    <span className="bg-muted flex h-2 overflow-hidden rounded-full">
                      <span
                        className="bg-tone-blue"
                        style={{
                          width: `${pct(r.sent - r.replied, r.leads)}%`,
                        }}
                      />
                      <span
                        className="bg-tone-salmon"
                        style={{
                          width: `${pct(r.replied - r.qualified, r.leads)}%`,
                        }}
                      />
                      <span
                        className="bg-tone-mint"
                        style={{ width: `${pct(r.qualified, r.leads)}%` }}
                      />
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {t('leads.nicheLine', {
                        leads: r.leads,
                        sent: r.sent,
                        replied: r.replied,
                        qualified: r.qualified,
                      })}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="max-h-80 overflow-auto rounded-xl border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">{t('leads.lead')}</th>
                    <th className="px-2 py-1 text-left">{t('leads.stage')}</th>
                    <th className="px-2 py-1 text-left">{t('leads.sent')}</th>
                    <th className="px-2 py-1 text-left">
                      {t('leads.followups')}
                    </th>
                    <th className="px-2 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => {
                    const st = stageOf(l);
                    return (
                      <tr key={l.id} className="border-t">
                        <td className="px-2 py-1">
                          <div className="font-medium">
                            {l.contact?.company ||
                              l.contact?.name ||
                              l.contact?.phone}
                          </div>
                          <div className="text-muted-foreground">
                            {l.contact?.phone}
                            {l.niche && ` · ${l.niche}`}
                          </div>
                        </td>
                        <td className="px-2 py-1">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${LEAD_TONE[st] ?? LEAD_TONE.queued}`}
                          >
                            {t(`leads.state.${st}`)}
                          </span>
                          {l.error && (st === 'skipped' || st === 'failed') && (
                            <span className="text-muted-foreground">
                              {' '}
                              · {reasonText(t, l.error)}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1">{day(l.sent_at)}</td>
                        <td className="px-2 py-1">{l.followups_sent}</td>
                        <td className="px-2 py-1 text-right">
                          {l.conversation_id && l.sent_at && (
                            <Link
                              className="text-primary underline"
                              href={`/inbox?c=${l.conversation_id}`}
                            >
                              {t('leads.open')}
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  );
}
