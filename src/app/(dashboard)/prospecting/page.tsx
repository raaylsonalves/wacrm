'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Loader2, Pause, Play, Plus, Target, X } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  contact: { name: string | null; phone: string; company: string | null } | null;
}
interface Campaign {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
  config: { channel_kind: 'waha' | 'cloud'; template_name?: string | null };
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
      <div className="text-muted-foreground truncate text-xs font-semibold">{label}</div>
      <div className="text-xl font-extrabold tabular-nums">{value}</div>
    </div>
  );
}

// One funnel step: count, share of the leads, and a bar in its tone.
function Step({ label, n, of, color }: { label: string; n: number; of: number; color: string }) {
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
  const [creating, setCreating] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    fetch('/api/prospecting/campaigns', { cache: 'no-store' })
      .then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => ({})) }))
      .then(({ ok, data }) => alive && setCampaigns(ok ? (data.campaigns ?? []) : []))
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

  async function act(id: string, action: 'pause' | 'resume' | 'cancel') {
    const res = await fetch(`/api/prospecting/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) toast.error(t.has(`errors.${data.error}`) ? t(`errors.${data.error}`) : t('errors.generic'));
    load();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-[26px] leading-tight font-bold tracking-[-0.02em] lg:text-[28px]">{t('title')}</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">{t('subtitle')}</p>
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
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
            <CampaignCard key={c.id} c={c} version={reloadKey} canManage={canManage} onAct={act} t={t} />
          ))}
        </div>
      )}

      {canManage && (
        <NewCampaignDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function Summary({ campaigns, t }: { campaigns: Campaign[]; t: ReturnType<typeof useTranslations> }) {
  const active = campaigns.filter((c) => c.status === 'running' || c.status === 'paused').length;
  const sent = campaigns.reduce((a, c) => a + (c.funnel?.sent ?? 0), 0);
  const replied = campaigns.reduce((a, c) => a + (c.funnel?.replied ?? 0), 0);
  const qualified = campaigns.reduce((a, c) => a + (c.funnel?.qualified ?? 0), 0);
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
              <Button size="sm" variant="outline" onClick={() => onAct(c.id, 'pause')}>
                <Pause className="size-3.5" />
                {t('pause')}
              </Button>
            )}
            {c.status === 'paused' && (
              <Button size="sm" variant="outline" onClick={() => onAct(c.id, 'resume')}>
                <Play className="size-3.5" />
                {t('resume')}
              </Button>
            )}
            {(c.status === 'running' || c.status === 'paused') && (
              <Button size="sm" variant="ghost" onClick={() => onAct(c.id, 'cancel')}>
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
              <div className="text-muted-foreground text-[11.5px] font-semibold">{t('funnel.leads')}</div>
              <div className="text-sm font-extrabold tabular-nums">{leads}</div>
            </div>
            <Step label={t('funnel.sent')} n={f.sent} of={leads} color="bg-tone-blue" />
            <Step label={t('funnel.replied')} n={f.replied} of={leads} color="bg-tone-salmon" />
            <Step label={t('funnel.qualified')} n={f.qualified} of={leads} color="bg-tone-mint" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              {t('funnel.details', {
                queued: f.queued,
                failed: f.failed,
                skipped: f.skipped,
                optedOut: f.opted_out,
              })}
              {(f.followed_up ?? 0) > 0 && ` · ${t('funnel.followedUp', { count: f.followed_up ?? 0 })}`}
            </p>
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
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

  return (
    <div>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        {t('leads.toggle')}
      </Button>
      {open &&
        (leads === null ? (
          <Loader2 className="text-muted-foreground mx-auto size-4 animate-spin" />
        ) : (
          <div className="mt-2 max-h-80 overflow-auto rounded-xl border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="px-2 py-1 text-left">{t('leads.lead')}</th>
                  <th className="px-2 py-1 text-left">{t('leads.stage')}</th>
                  <th className="px-2 py-1 text-left">{t('leads.sent')}</th>
                  <th className="px-2 py-1 text-left">{t('leads.followups')}</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => {
                  const st = stageOf(l);
                  return (
                    <tr key={l.id} className="border-t">
                      <td className="px-2 py-1">
                        <div className="font-medium">{l.contact?.company || l.contact?.name || l.contact?.phone}</div>
                        <div className="text-muted-foreground">{l.contact?.phone}</div>
                      </td>
                      <td className="px-2 py-1">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${LEAD_TONE[st] ?? LEAD_TONE.queued}`}
                        >
                          {t(`leads.state.${st}`)}
                        </span>
                        {l.error && (st === 'skipped' || st === 'failed') && (
                          <span className="text-muted-foreground"> · {reasonText(t, l.error)}</span>
                        )}
                      </td>
                      <td className="px-2 py-1">{day(l.sent_at)}</td>
                      <td className="px-2 py-1">{l.followups_sent}</td>
                      <td className="px-2 py-1 text-right">
                        {l.conversation_id && l.sent_at && (
                          <Link className="text-primary underline" href={`/inbox?c=${l.conversation_id}`}>
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
        ))}
    </div>
  );
}

/** An approved template plus a source for each {{n}} body variable. */
function TemplateFields({
  templates,
  loaded,
  value,
  onChange,
  params,
  onParams,
  t,
}: {
  templates: TemplateOption[];
  /** False until the templates query has answered. */
  loaded: boolean;
  value: string;
  onChange: (v: string) => void;
  params: string[];
  onParams: (p: string[]) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const template = templates.find((x) => `${x.name}|${x.language}` === value) ?? null;
  const varCount = useMemo(() => {
    const nums = [...(template?.body_text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
  }, [template]);
  const shown = Array.from({ length: varCount }, (_, i) => params[i] ?? 'first_name');
  const setAt = (i: number, v: string) => onParams(shown.map((x, j) => (j === i ? v : x)));

  return (
    <div className="space-y-2">
      <Select value={value || null} onValueChange={(v) => onChange(v ?? '')}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={t('form.pick')}>
            {(v: string) => v?.replace('|', ' · ') || t('form.pick')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {templates.map((x) => (
            <SelectItem key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>
              {x.name} · {x.language}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {loaded && templates.length === 0 && (
        <p className="text-tone-salmon-ink text-xs">{t('form.noTemplates')}</p>
      )}
      {template && (
        <p className="bg-muted/50 rounded-md p-2 text-xs whitespace-pre-wrap">{template.body_text}</p>
      )}
      {shown.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-muted-foreground w-12 text-xs">{`{{${i + 1}}}`}</span>
          <Select
            value={(TOKENS as readonly string[]).includes(p) ? p : 'text'}
            onValueChange={(v) => setAt(i, v === 'text' ? '' : (v ?? ''))}
          >
            <SelectTrigger className="w-44">
              <SelectValue>{(v: string) => t(`form.token.${v}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[...TOKENS, 'text'].map((tok) => (
                <SelectItem key={tok} value={tok}>
                  {t(`form.token.${tok}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!(TOKENS as readonly string[]).includes(p) && (
            <Input value={p} onChange={(e) => setAt(i, e.target.value)} />
          )}
        </div>
      ))}
    </div>
  );
}

interface Option {
  id: string;
  name: string;
}
interface TemplateOption {
  name: string;
  language: string;
  body_text: string;
}

const TOKENS = ['first_name', 'name', 'company'] as const;

function NewCampaignDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Prospecting');
  const supabase = createClient();
  const { accountId } = useAuth();

  const [lists, setLists] = useState<Option[]>([]);
  const [agents, setAgents] = useState<Option[]>([]);
  const [waha, setWaha] = useState<Option[]>([]);
  const [pipelines, setPipelines] = useState<Option[]>([]);
  const [stages, setStages] = useState<Option[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [name, setName] = useState('');
  const [listId, setListId] = useState('');
  const [channel, setChannel] = useState('cloud'); // 'cloud' | waha channel id
  const [agentId, setAgentId] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [entryStage, setEntryStage] = useState('');
  const [qualifiedStage, setQualifiedStage] = useState('');
  const [instruction, setInstruction] = useState('');
  const [criteria, setCriteria] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [legal, setLegal] = useState('');
  const [dailyLimit, setDailyLimit] = useState(10);
  const [interval, setInterval] = useState(15);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(18);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [followup, setFollowup] = useState(false);
  const [followupDays, setFollowupDays] = useState(3);
  const [followupMax, setFollowupMax] = useState(1);
  const [followupKey, setFollowupKey] = useState('');
  const [followupParams, setFollowupParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !accountId) return;
    void (async () => {
      const [tags, ch, pl, tpl, ag] = await Promise.all([
        supabase.from('tags').select('id, name').eq('account_id', accountId).order('name'),
        supabase.from('whatsapp_waha_channels').select('id, label').eq('account_id', accountId),
        supabase.from('pipelines').select('id, name').eq('account_id', accountId),
        supabase
          .from('message_templates')
          .select('name, language, body_text')
          .eq('account_id', accountId)
          .in('status', ['APPROVED', 'Approved']),
        fetch('/api/ai/agents', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { agents: [] })),
      ]);
      setLists((tags.data ?? []).map((x) => ({ id: x.id, name: x.name })));
      setWaha((ch.data ?? []).map((x) => ({ id: x.id, name: x.label })));
      setPipelines((pl.data ?? []).map((x) => ({ id: x.id, name: x.name })));
      setTemplates((tpl.data ?? []) as TemplateOption[]);
      setLoaded(true);
      setAgents(((ag.agents ?? []) as Option[]).map((a) => ({ id: a.id, name: a.name })));
    })();
  }, [open, accountId, supabase]);

  useEffect(() => {
    if (!pipelineId) return;
    void supabase
      .from('pipeline_stages')
      .select('id, name')
      .eq('pipeline_id', pipelineId)
      .order('position')
      .then(({ data }) => setStages((data ?? []).map((x) => ({ id: x.id, name: x.name }))));
  }, [pipelineId, supabase]);

  const isCloud = channel === 'cloud';
  const template = templates.find((x) => `${x.name}|${x.language}` === templateKey) ?? null;
  const followupTemplate = templates.find((x) => `${x.name}|${x.language}` === followupKey) ?? null;
  const varsOf = (tpl: TemplateOption | null) => {
    const nums = [...(tpl?.body_text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
  };
  const fill = (p: string[], n: number) => Array.from({ length: n }, (_, i) => p[i] ?? 'first_name');

  const labelOf = (list: Option[], id: string) => list.find((x) => x.id === id)?.name ?? '';

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch('/api/prospecting/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          source_tag_id: listId,
          config: {
            channel_kind: isCloud ? 'cloud' : 'waha',
            channel_id: isCloud ? null : channel,
            agent_id: agentId,
            pipeline_id: pipelineId,
            entry_stage_id: entryStage,
            qualified_stage_id: qualifiedStage,
            instruction,
            criteria,
            template_name: template?.name ?? null,
            template_language: template?.language ?? null,
            template_params: fill(params, varsOf(template)),
            legal_basis_ref: legal,
            daily_limit: dailyLimit,
            interval_minutes: interval,
            window_start_hour: startHour,
            window_end_hour: endHour,
            weekdays,
            followup_enabled: followup,
            followup_after_days: followupDays,
            followup_max: followupMax,
            followup_template_name: followupTemplate?.name ?? null,
            followup_template_language: followupTemplate?.language ?? null,
            followup_template_params: fill(followupParams, varsOf(followupTemplate)),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t.has(`errors.${data.error}`) ? t(`errors.${data.error}`) : t('errors.generic'));
        return;
      }
      toast.success(t('started', { queued: data.queued ?? 0, skipped: data.skipped ?? 0 }));
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  const pick = (
    value: string,
    onChange: (v: string) => void,
    options: Option[],
    placeholder: string,
  ) => (
    <Select value={value || null} onValueChange={(v) => onChange(v ?? '')}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder}>{(v: string) => labelOf(options, v) || placeholder}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const channelOptions: Option[] = [
    { id: 'cloud', name: t('channel.cloud') },
    ...waha.map((w) => ({ id: w.id, name: `${t('channel.waha')} — ${w.name}` })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('new')}</DialogTitle>
          <DialogDescription>{t('newHint')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('form.name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.list')}</Label>
            {pick(listId, setListId, lists, t('form.pick'))}
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.channel')}</Label>
            {pick(channel, setChannel, channelOptions, t('form.pick'))}
          </div>
          <p className="text-muted-foreground text-xs sm:col-span-2">
            {isCloud ? t('form.cloudHint') : t('form.wahaHint')}
          </p>
          <div className="space-y-1.5">
            <Label>{t('form.agent')}</Label>
            {pick(agentId, setAgentId, agents, t('form.pick'))}
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.pipeline')}</Label>
            {pick(pipelineId, setPipelineId, pipelines, t('form.pick'))}
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.entryStage')}</Label>
            {pick(entryStage, setEntryStage, stages, t('form.pick'))}
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.qualifiedStage')}</Label>
            {pick(qualifiedStage, setQualifiedStage, stages, t('form.pick'))}
          </div>

          {isCloud ? (
            <div className="space-y-2 sm:col-span-2">
              <Label>{t('form.template')}</Label>
              <TemplateFields
                templates={templates}
                loaded={loaded}
                value={templateKey}
                onChange={setTemplateKey}
                params={params}
                onParams={setParams}
                t={t}
              />
            </div>
          ) : (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('form.instruction')}</Label>
              <Textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={3}
                placeholder={t('form.instructionPlaceholder')}
              />
            </div>
          )}

          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('form.criteria')}</Label>
            <Textarea
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              rows={2}
              placeholder={t('form.criteriaPlaceholder')}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('form.legal')}</Label>
            <Textarea
              value={legal}
              onChange={(e) => setLegal(e.target.value)}
              rows={2}
              placeholder={t('form.legalPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.dailyLimit')}</Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.interval')}</Label>
            <Input
              type="number"
              min={5}
              max={1440}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.startHour')}</Label>
            <Input type="number" min={0} max={23} value={startHour} onChange={(e) => setStartHour(Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.endHour')}</Label>
            <Input type="number" min={1} max={24} value={endHour} onChange={(e) => setEndHour(Number(e.target.value))} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('form.weekdays')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={weekdays.includes(d) ? 'default' : 'outline'}
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d]))
                  }
                >
                  {t(`form.day.${d}`)}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-muted-foreground text-xs sm:col-span-2">{t('form.pacingHint')}</p>

          <div className="space-y-3 rounded-md border p-3 sm:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{t('form.followup')}</p>
                <p className="text-muted-foreground text-xs">
                  {isCloud ? t('form.followupCloudHint') : t('form.followupWahaHint')}
                </p>
              </div>
              <Switch checked={followup} onCheckedChange={setFollowup} />
            </div>
            {followup && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t('form.followupDays')}</Label>
                  <Input type="number" min={1} max={14} value={followupDays} onChange={(e) => setFollowupDays(Number(e.target.value))} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('form.followupMax')}</Label>
                  <Input type="number" min={1} max={2} value={followupMax} onChange={(e) => setFollowupMax(Number(e.target.value))} />
                </div>
                {isCloud && (
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>{t('form.followupTemplate')}</Label>
                    <TemplateFields
                      templates={templates}
                loaded={loaded}
                      value={followupKey}
                      onChange={setFollowupKey}
                      params={followupParams}
                      onParams={setFollowupParams}
                      t={t}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => void submit()} disabled={busy || !name || !listId || !agentId}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
