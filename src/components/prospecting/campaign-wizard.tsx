'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CSV_MAX_BYTES, decodeCsv, parseCsv } from '@/lib/csv/parse';
import { nicheCounts, planImport, type ImportPlan, type PlannedRow } from '@/lib/contacts/import-plan';
import {
  MAX_DAILY,
  maxMessages,
  renderTemplateParams,
  warmupCeiling,
} from '@/lib/prospecting/logic';

type T = ReturnType<typeof useTranslations>;

interface Option {
  id: string;
  name: string;
}
interface WahaOption extends Option {
  connectedAt: string | null;
}
interface TemplateOption {
  name: string;
  language: string;
  category: string | null;
  body_text: string;
}
interface MetaStatus {
  configured: boolean;
  phone?: string | null;
  quality?: string | null;
  tier?: string | null;
  limit?: number | null;
  error?: string;
}

/** Where the contacts came from — sets the consent basis of the import. */
type Origin = 'public_business' | 'opt_in';

const TOKENS = ['first_name', 'name', 'company'] as const;
const STEPS = ['list', 'message', 'pace', 'review'] as const;
const COST_KEY = 'prospecting.costPerMessage';
// Meta's Brazil per-message list price (USD) converted at ~R$5,50; only a
// starting point — the account's real rate replaces it once typed.
const REF_COST_BRL: Record<string, number> = { MARKETING: 0.35, UTILITY: 0.04, AUTHENTICATION: 0.17 };
const META_PRICING_URL = 'https://developers.facebook.com/docs/whatsapp/pricing';

const keyOf = (x: TemplateOption) => `${x.name}|${x.language}`;
const varsOf = (tpl: TemplateOption | null) => {
  const nums = [...(tpl?.body_text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
};
const fill = (p: string[], n: number, dflt: string) => Array.from({ length: n }, (_, i) => p[i] ?? dflt);

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * New prospecting campaign, in four steps (specs/prospecting-csv-import.md):
 * the list (a file attached here, split by niche, or an existing list),
 * the message, the pace — anti-ban pacing for WAHA, Meta's limit and cost
 * for the official number — and the agent. Nothing is written until the
 * last step: the campaign is validated, then the file is imported, then
 * the campaign starts.
 */
export function CampaignWizard() {
  const t = useTranslations('Prospecting');
  const tw = useTranslations('Prospecting.wizard');
  const router = useRouter();
  const supabase = createClient();
  const { accountId } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);

  // Options.
  const [lists, setLists] = useState<Option[]>([]);
  const [agents, setAgents] = useState<Option[]>([]);
  const [waha, setWaha] = useState<WahaOption[]>([]);
  const [pipelines, setPipelines] = useState<Option[]>([]);
  const [stages, setStages] = useState<Option[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [meta, setMeta] = useState<MetaStatus | null>(null);

  // Step 1 — list.
  const [source, setSource] = useState<'file' | 'list'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [split, setSplit] = useState(true);
  const [origin, setOrigin] = useState<Origin>('public_business');
  const [listId, setListId] = useState('');
  const [listCount, setListCount] = useState<number | null>(null);

  // Step 2 — message.
  const [channel, setChannel] = useState('cloud'); // 'cloud' | WAHA channel id
  const [templateKey, setTemplateKey] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [instruction, setInstruction] = useState('');
  const [followup, setFollowup] = useState(false);
  const [followupDays, setFollowupDays] = useState(3);
  const [followupMax, setFollowupMax] = useState(1);
  const [followupKey, setFollowupKey] = useState('');
  const [followupParams, setFollowupParams] = useState<string[]>([]);

  // Step 3 — pace.
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(18);
  const [dailyLimit, setDailyLimit] = useState(10);
  const [interval, setIntervalMin] = useState(15);
  const [cost, setCost] = useState('');

  // Step 4 — agent and review.
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [criteria, setCriteria] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [entryStage, setEntryStage] = useState('');
  const [qualifiedStage, setQualifiedStage] = useState('');
  const [legal, setLegal] = useState('');
  const [legalTouched, setLegalTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    void (async () => {
      const [tags, ch, pl, tpl, ag] = await Promise.all([
        supabase.from('tags').select('id, name').eq('account_id', accountId).order('name'),
        supabase.from('whatsapp_waha_channels').select('id, label, connected_at').eq('account_id', accountId),
        supabase.from('pipelines').select('id, name').eq('account_id', accountId),
        supabase
          .from('message_templates')
          .select('name, language, category, body_text')
          .eq('account_id', accountId)
          .in('status', ['APPROVED', 'Approved']),
        fetch('/api/ai/agents', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { agents: [] })),
      ]);
      setLists((tags.data ?? []).map((x) => ({ id: x.id, name: x.name })));
      setWaha((ch.data ?? []).map((x) => ({ id: x.id, name: x.label, connectedAt: x.connected_at })));
      setPipelines((pl.data ?? []).map((x) => ({ id: x.id, name: x.name })));
      setTemplates((tpl.data ?? []) as TemplateOption[]);
      setAgents(((ag.agents ?? []) as Option[]).map((a) => ({ id: a.id, name: a.name })));
      setLoaded(true);
    })();
  }, [accountId, supabase]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(COST_KEY);
      if (saved) setCost(saved);
    } catch {
      // Storage blocked: the field simply starts empty.
    }
  }, []);

  useEffect(() => {
    if (!pipelineId) return;
    void supabase
      .from('pipeline_stages')
      .select('id, name')
      .eq('pipeline_id', pipelineId)
      .order('position')
      .then(({ data }) => setStages((data ?? []).map((x) => ({ id: x.id, name: x.name }))));
  }, [pipelineId, supabase]);

  useEffect(() => {
    if (source !== 'list' || !listId) return;
    setListCount(null);
    void supabase
      .from('contact_tags')
      .select('contact_id', { count: 'exact', head: true })
      .eq('tag_id', listId)
      .then(({ count }) => setListCount(count ?? 0));
  }, [source, listId, supabase]);

  const isCloud = channel === 'cloud';

  useEffect(() => {
    if (!isCloud || meta) return;
    void fetch('/api/prospecting/meta-status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((d: MetaStatus) => setMeta(d))
      .catch(() => setMeta({ configured: false }));
  }, [isCloud, meta]);

  // The official number's pace is Meta's; WAHA keeps the anti-ban defaults.
  useEffect(() => {
    setDailyLimit(isCloud ? 100 : 10);
  }, [isCloud]);

  // ---------------------------------------------------------------- list
  const niches = useMemo(() => (plan ? nicheCounts(plan.rows) : []), [plan]);
  const hasNiches = niches.some(([n]) => n !== '');
  const chosenRows: PlannedRow[] = useMemo(
    () => (plan ? plan.rows.filter((r) => !hasNiches || picked.has(r.niche ?? '')) : []),
    [plan, picked, hasNiches],
  );
  const skippedBy = (reason: string) => plan?.skipped.filter((s) => s.reason === reason).length ?? 0;
  const leads = source === 'file' ? chosenRows.length : (listCount ?? 0);
  const sample = chosenRows[0] ?? null;

  async function pickFile(f: File | undefined) {
    if (!f) return;
    if (f.size > CSV_MAX_BYTES) {
      toast.error(tw('list.tooLarge'));
      return;
    }
    const next = planImport(parseCsv(decodeCsv(new Uint8Array(await f.arrayBuffer()))));
    if (!next.columns.includes('phone')) {
      toast.error(tw('list.noPhone'));
      return;
    }
    setFile(f);
    setPlan(next);
    setPicked(new Set(nicheCounts(next.rows).map(([n]) => n)));
    if (!name) setName(f.name.replace(/\.csv$/i, ''));
    // A business list greets the company; a list of people, the person.
    if (next.businessList) {
      setParams((p) => (p.length ? p : ['company']));
      setFollowupParams((p) => (p.length ? p : ['company']));
    }
  }

  const togglePicked = (n: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  // ------------------------------------------------------------- message
  const template = templates.find((x) => keyOf(x) === templateKey) ?? null;
  const followupTemplate = templates.find((x) => keyOf(x) === followupKey) ?? null;
  const dfltToken = plan?.businessList ? 'company' : 'first_name';
  const templateParams = fill(params, varsOf(template), dfltToken);
  const followupTemplateParams = fill(followupParams, varsOf(followupTemplate), dfltToken);
  const wahaChannel = waha.find((w) => w.id === channel) ?? null;

  // ---------------------------------------------------------------- pace
  const tierCap = meta?.limit ?? null;
  const dailyMax = isCloud ? Math.min(MAX_DAILY.cloud, tierCap ?? MAX_DAILY.cloud) : MAX_DAILY.waha;
  const warmup = wahaChannel ? warmupCeiling('waha', wahaChannel.connectedAt, new Date()) : null;
  const effectiveDaily = Math.max(1, Math.min(dailyLimit, dailyMax, warmup ?? Infinity));
  const days = leads > 0 ? Math.ceil(leads / effectiveDaily) : 0;
  // Until the admin types their own rate, estimate with Meta's Brazil list
  // price for the template's category, so the total is never blank.
  const refCost = REF_COST_BRL[template?.category ?? 'MARKETING'] ?? REF_COST_BRL.MARKETING;
  const typedCost = Number(cost.replace(',', '.'));
  const usingRef = !cost.trim() || !Number.isFinite(typedCost);
  const costNum = usingRef ? refCost : typedCost;
  const messages = maxMessages(leads, { followup_enabled: followup, followup_max: followupMax });
  const costTotal = isCloud ? messages * costNum : null;
  const allDay = startHour === 0 && endHour === 24 && weekdays.length === 7;

  // ---------------------------------------------------------------- review
  const defaultLegal = tw(`origin.${origin}.legal`);
  useEffect(() => {
    if (!legalTouched) setLegal(defaultLegal);
  }, [defaultLegal, legalTouched]);

  const stepOk = [
    source === 'file' ? chosenRows.length > 0 : !!listId && (listCount ?? 0) > 0,
    isCloud
      ? !!template && (!followup || !!followupTemplate)
      : !!wahaChannel && instruction.trim().length >= 10,
    // An expired token would only surface as the first send failing.
    weekdays.length > 0 && endHour > startHour && (!isCloud || (!!meta?.configured && !meta.error)),
    !!name.trim() &&
      !!agentId &&
      !!pipelineId &&
      !!entryStage &&
      !!qualifiedStage &&
      entryStage !== qualifiedStage &&
      criteria.trim().length >= 10 &&
      legal.trim().length >= 10,
  ];

  function config() {
    return {
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
      template_params: templateParams,
      legal_basis_ref: legal,
      daily_limit: Math.min(dailyLimit, dailyMax),
      interval_minutes: interval,
      cost_per_message: isCloud ? String(costNum) : null,
      window_start_hour: startHour,
      window_end_hour: endHour,
      weekdays,
      followup_enabled: followup,
      followup_after_days: followupDays,
      followup_max: followupMax,
      followup_template_name: followupTemplate?.name ?? null,
      followup_template_language: followupTemplate?.language ?? null,
      followup_template_params: followupTemplateParams,
    };
  }

  const errorText = (code: string) =>
    t.has(`errors.${code}`) ? t(`errors.${code}`) : tw.has(`errors.${code}`) ? tw(`errors.${code}`) : t('errors.generic');

  async function start() {
    setBusy(true);
    try {
      const post = (body: unknown) =>
        fetch('/api/prospecting/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => ({})) }));

      // 1) Everything the campaign needs, checked before anything is written.
      const check = await post({ name, validate_only: true, config: config() });
      if (!check.ok) {
        toast.error(errorText(String(check.data.error ?? '')));
        return;
      }

      // 2) The file becomes contacts and a list (one tag per niche when split).
      let sourceTagId = listId;
      let importId: string | null = null;
      if (source === 'file' && file) {
        const body = new FormData();
        body.append('file', file);
        body.append('name', name.trim());
        body.append('consent_basis', origin === 'opt_in' ? 'opt_in' : 'legitimate_interest');
        body.append('legal_basis_ref', legal.trim());
        body.append('update_policy', 'fill_empty');
        if (hasNiches) {
          body.append('niches', JSON.stringify([...picked]));
          if (split) body.append('niche_tags', '1');
        }
        const res = await fetch('/api/contacts/imports', { method: 'POST', body });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.list_tag_id) {
          toast.error(tw('errors.import_failed'));
          return;
        }
        sourceTagId = data.list_tag_id as string;
        importId = data.id as string;
      }

      // 3) The campaign itself; the first message goes out right away.
      const created = await post({ name, source_tag_id: sourceTagId, import_id: importId, config: config() });
      if (!created.ok) {
        toast.error(errorText(String(created.data.error ?? '')));
        return;
      }
      toast.success(t('started', { queued: created.data.queued ?? 0, skipped: created.data.skipped ?? 0 }));
      router.push('/prospecting');
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ UI
  const pick = (value: string, onChange: (v: string) => void, options: Option[], id?: string) => (
    <Select value={value || null} onValueChange={(v) => onChange(v ?? '')}>
      <SelectTrigger className="w-full" id={id}>
        <SelectValue placeholder={t('form.pick')}>
          {(v: string) => options.find((o) => o.id === v)?.name ?? t('form.pick')}
        </SelectValue>
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Link href="/prospecting" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
            <ArrowLeft className="size-3.5" />
            {t('title')}
          </Link>
          <h1 className="text-foreground text-[26px] leading-tight font-bold tracking-[-0.02em] lg:text-[28px]">
            {t('new')}
          </h1>
        </div>
        <ol className="flex flex-wrap gap-1.5">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                disabled={i > step && !stepOk.slice(0, i).every(Boolean)}
                onClick={() => setStep(i)}
                aria-current={i === step ? 'step' : undefined}
                className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  i === step
                    ? 'bg-foreground text-background'
                    : i < step
                      ? 'bg-tone-mint-soft text-tone-mint-ink'
                      : 'border-border bg-card text-muted-foreground border'
                }`}
              >
                {i < step ? <Check className="size-3.5" /> : <span className="tabular-nums">{i + 1}</span>}
                {tw(`steps.${s}`)}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {step === 0 && (
            <>
              <Panel>
                <div className="bg-muted flex w-fit gap-1 rounded-xl p-1" role="tablist">
                  {(['file', 'list'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="tab"
                      aria-selected={source === s}
                      onClick={() => setSource(s)}
                      className={`rounded-lg px-3.5 py-1.5 text-[13px] font-bold ${
                        source === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
                      }`}
                    >
                      {tw(`list.source.${s}`)}
                    </button>
                  ))}
                </div>

                {source === 'file' ? (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(e) => void pickFile(e.target.files?.[0])}
                    />
                    {file && plan ? (
                      <div className="flex items-center gap-3 rounded-2xl border border-dashed p-3.5">
                        <span className="bg-tone-mint-soft text-tone-mint-ink flex size-10 shrink-0 items-center justify-center rounded-xl">
                          <FileSpreadsheet className="size-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold">{file.name}</p>
                          <p className="text-muted-foreground text-xs">
                            {tw('list.fileMeta', { rows: plan.rows.length + plan.skipped.length })}
                            {plan.businessList && ` · ${tw('list.mapsDetected')}`}
                          </p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                          {tw('list.replace')}
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        className="hover:bg-muted/50 flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center transition-colors"
                      >
                        <Upload className="text-muted-foreground size-6" />
                        <span className="text-sm font-bold">{tw('list.drop')}</span>
                        <span className="text-muted-foreground text-xs">{tw('list.dropHint')}</span>
                      </button>
                    )}
                    {plan && (
                      <div className="flex flex-wrap gap-1.5">
                        {plan.columns.map((c) => (
                          <span key={c} className="bg-muted rounded-lg px-2 py-1 text-xs font-semibold">
                            {/* On a Maps export the name column holds the business. */}
                            {tw(`list.column.${plan.businessList && c === 'name' ? 'company' : c}`)}
                          </span>
                        ))}
                        {plan.ignoredColumns.length > 0 && (
                          <span className="text-muted-foreground px-1 py-1 text-xs">
                            {tw('list.ignored', { count: plan.ignoredColumns.length })}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="pw-list">{t('form.list')}</Label>
                    {pick(listId, setListId, lists, 'pw-list')}
                    <p className="text-muted-foreground text-xs">{tw('list.existingHint')}</p>
                  </div>
                )}
              </Panel>

              {source === 'file' && plan && (
                <div className="grid gap-4 md:grid-cols-2">
                  <Panel>
                    <h2 className="text-[15px] font-extrabold">{tw('list.phones')}</h2>
                    <ul className="space-y-2 text-sm">
                      <Row dot="bg-tone-mint" label={tw('list.mobile')} value={plan.rows.length} />
                      <Row dot="bg-tone-salmon" label={tw('list.landline')} hint={tw('list.landlineHint')} value={skippedBy('landline')} />
                      <Row dot="bg-tone-pink-ink" label={tw('list.invalid')} value={skippedBy('invalid_phone') + skippedBy('bad_email')} />
                      <Row dot="bg-muted-foreground" label={tw('list.duplicate')} value={skippedBy('duplicate_in_file')} />
                    </ul>
                    <p className="text-muted-foreground text-xs">{tw('list.phonesHint')}</p>
                  </Panel>

                  <Panel>
                    <div className="flex items-baseline justify-between gap-2">
                      <h2 className="text-[15px] font-extrabold">{tw('list.niches')}</h2>
                      {hasNiches && <span className="text-muted-foreground text-xs">{tw('list.nichesHint')}</span>}
                    </div>
                    {hasNiches ? (
                      <>
                        <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                          {niches.map(([n, count]) => (
                            <li key={n}>
                              <label className="flex items-center gap-2.5 text-sm">
                                <Checkbox checked={picked.has(n)} onCheckedChange={() => togglePicked(n)} />
                                <span className="min-w-0 flex-1 truncate">{n || tw('list.noNiche')}</span>
                                <span className="font-bold tabular-nums">{count}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                        <label className="bg-tone-lilac-soft text-tone-lilac-ink flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-semibold">
                          <Checkbox checked={split} onCheckedChange={(v) => setSplit(v === true)} />
                          {tw('list.split')}
                        </label>
                      </>
                    ) : (
                      <p className="text-muted-foreground text-sm">{tw('list.noNicheColumn')}</p>
                    )}
                  </Panel>
                </div>
              )}

              {source === 'file' && (
                <Panel>
                  <h2 className="text-[15px] font-extrabold">{tw('origin.title')}</h2>
                  <RadioGroup
                    value={origin}
                    onValueChange={(v) => setOrigin(v as Origin)}
                    className="grid gap-2.5 md:grid-cols-2"
                  >
                    {(['public_business', 'opt_in'] as const).map((o) => (
                      <label
                        key={o}
                        className={`flex cursor-pointer gap-3 rounded-2xl border p-3.5 ${
                          origin === o ? 'border-tone-lilac bg-tone-lilac-soft' : ''
                        }`}
                      >
                        <RadioGroupItem value={o} className="mt-0.5" />
                        <span>
                          <span className="block text-[13px] font-bold">{tw(`origin.${o}.label`)}</span>
                          <span className="text-muted-foreground block text-xs">{tw(`origin.${o}.hint`)}</span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                  <p className="text-muted-foreground text-xs">{tw('origin.bought')}</p>
                </Panel>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <Panel>
                <h2 className="text-[15px] font-extrabold">{tw('message.channel')}</h2>
                <RadioGroup value={channel} onValueChange={(v) => setChannel(String(v))} className="grid gap-2.5 md:grid-cols-2">
                  <ChannelCard value="cloud" active={isCloud} title={t('channel.cloud')} hint={tw('message.cloudHint')} />
                  {waha.map((w) => (
                    <ChannelCard
                      key={w.id}
                      value={w.id}
                      active={channel === w.id}
                      title={`${t('channel.waha')} — ${w.name}`}
                      hint={tw('message.wahaHint')}
                    />
                  ))}
                </RadioGroup>
                {loaded && waha.length === 0 && (
                  <p className="text-muted-foreground text-xs">{tw('message.noWaha')}</p>
                )}
              </Panel>

              {isCloud ? (
                <Panel>
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="text-[15px] font-extrabold">{t('form.template')}</h2>
                    <span className="text-muted-foreground text-xs">{tw('message.approvedOnly')}</span>
                  </div>
                  <TemplateFields
                    templates={templates}
                    loaded={loaded}
                    value={templateKey}
                    onChange={setTemplateKey}
                    params={templateParams}
                    onParams={setParams}
                    t={t}
                  />
                  <FollowupFields
                    t={t}
                    isCloud
                    enabled={followup}
                    onEnabled={setFollowup}
                    days={followupDays}
                    onDays={setFollowupDays}
                    max={followupMax}
                    onMax={setFollowupMax}
                  >
                    <TemplateFields
                      templates={templates}
                      loaded={loaded}
                      value={followupKey}
                      onChange={setFollowupKey}
                      params={followupTemplateParams}
                      onParams={setFollowupParams}
                      t={t}
                    />
                  </FollowupFields>
                </Panel>
              ) : (
                <Panel>
                  <h2 className="text-[15px] font-extrabold">{t('form.instruction')}</h2>
                  <Textarea
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    rows={4}
                    placeholder={t('form.instructionPlaceholder')}
                  />
                  <p className="text-muted-foreground text-xs">{t('form.wahaHint')}</p>
                  <FollowupFields
                    t={t}
                    isCloud={false}
                    enabled={followup}
                    onEnabled={setFollowup}
                    days={followupDays}
                    onDays={setFollowupDays}
                    max={followupMax}
                    onMax={setFollowupMax}
                  />
                </Panel>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <Panel>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[15px] font-extrabold">{tw('pace.when')}</h2>
                  <button
                    type="button"
                    aria-pressed={allDay}
                    onClick={() => {
                      if (allDay) {
                        setWeekdays([1, 2, 3, 4, 5]);
                        setStartHour(9);
                        setEndHour(18);
                      } else {
                        setWeekdays([0, 1, 2, 3, 4, 5, 6]);
                        setStartHour(0);
                        setEndHour(24);
                      }
                    }}
                    className={`rounded-full px-3 py-1 text-xs font-bold ${
                      allDay ? 'bg-tone-lilac-soft text-tone-lilac-ink' : 'border text-muted-foreground'
                    }`}
                  >
                    {tw('pace.allDay')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={weekdays.includes(d)}
                      onClick={() => setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d]))}
                      className={`w-14 rounded-xl py-2 text-[13px] font-bold ${
                        weekdays.includes(d) ? 'bg-tone-lilac-soft text-tone-lilac-ink' : 'border text-muted-foreground'
                      }`}
                    >
                      {t(`form.day.${d}`)}
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberField id="pw-start" label={t('form.startHour')} value={startHour} min={0} max={23} onChange={setStartHour} />
                  <NumberField id="pw-end" label={t('form.endHour')} value={endHour} min={1} max={24} onChange={setEndHour} />
                </div>
                <p className="text-muted-foreground text-xs">{tw('pace.timezone')}</p>
              </Panel>

              {isCloud ? (
                <>
                  <Panel>
                    <h2 className="text-[15px] font-extrabold">{tw('pace.meta.title')}</h2>
                    {meta === null ? (
                      <Loader2 className="text-muted-foreground size-4 animate-spin" />
                    ) : !meta.configured ? (
                      <p className="text-tone-salmon-ink text-sm">{t('errors.whatsapp_not_configured')}</p>
                    ) : meta.error ? (
                      <p className="text-tone-salmon-ink text-sm">{tw('pace.meta.error', { error: meta.error })}</p>
                    ) : (
                      <div className="grid gap-2.5 sm:grid-cols-3">
                        <Stat label={tw('pace.meta.number')} value={meta.phone ?? '—'} />
                        <Stat
                          label={tw('pace.meta.tier')}
                          value={meta.limit ? tw('pace.meta.perDay', { count: meta.limit }) : tw('pace.meta.unlimited')}
                        />
                        <Stat
                          label={tw('pace.meta.quality')}
                          value={tw.has(`pace.meta.q.${meta.quality}`) ? tw(`pace.meta.q.${meta.quality}`) : (meta.quality ?? '—')}
                        />
                      </div>
                    )}
                    <p className="text-muted-foreground text-xs">{tw('pace.meta.tierHint')}</p>
                    <NumberField
                      id="pw-daily"
                      label={t('form.dailyLimit')}
                      value={dailyLimit}
                      min={1}
                      max={dailyMax}
                      onChange={setDailyLimit}
                    />
                  </Panel>
                  <Panel>
                    <h2 className="text-[15px] font-extrabold">{tw('pace.cost.title')}</h2>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="pw-cost">{tw('pace.cost.perMessage')}</Label>
                        <Input
                          id="pw-cost"
                          inputMode="decimal"
                          placeholder={refCost.toFixed(2).replace('.', ',')}
                          value={cost}
                          onChange={(e) => {
                            setCost(e.target.value);
                            try {
                              window.localStorage.setItem(COST_KEY, e.target.value);
                            } catch {
                              // Not remembered; nothing else depends on it.
                            }
                          }}
                        />
                      </div>
                      <Stat
                        label={
                          tw('pace.cost.total', { count: messages }) + (usingRef ? ` · ${tw('pace.cost.reference')}` : '')
                        }
                        value={costTotal === null ? '—' : `≈ ${money(costTotal)}`}
                      />
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {tw('pace.cost.hint', { category: template?.category ?? 'MARKETING' })}{' '}
                      <a href={META_PRICING_URL} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-0.5 underline">
                        {tw('pace.cost.link')}
                        <ExternalLink className="size-3" />
                      </a>
                    </p>
                  </Panel>
                </>
              ) : (
                <Panel>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="text-tone-mint-ink size-4" />
                    <h2 className="text-[15px] font-extrabold">{tw('pace.antiban.title')}</h2>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <NumberField id="pw-daily" label={t('form.dailyLimit')} value={dailyLimit} min={1} max={dailyMax} onChange={setDailyLimit} />
                    <NumberField id="pw-interval" label={t('form.interval')} value={interval} min={5} max={1440} onChange={setIntervalMin} />
                  </div>
                  <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
                    <li>{tw('pace.antiban.jitter')}</li>
                    <li>
                      {warmup !== null
                        ? tw('pace.antiban.warmup', { count: warmup })
                        : tw('pace.antiban.warmupGeneric')}
                    </li>
                    <li>{tw('pace.antiban.optout')}</li>
                    <li>{tw('pace.antiban.pause')}</li>
                  </ul>
                </Panel>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <Panel>
                <div className="space-y-1.5">
                  <Label htmlFor="pw-name">{t('form.name')}</Label>
                  <Input id="pw-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pw-agent">{t('form.agent')}</Label>
                  {pick(agentId, setAgentId, agents, 'pw-agent')}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pw-criteria">{t('form.criteria')}</Label>
                  <Textarea
                    id="pw-criteria"
                    value={criteria}
                    onChange={(e) => setCriteria(e.target.value)}
                    rows={2}
                    placeholder={t('form.criteriaPlaceholder')}
                  />
                </div>
              </Panel>
              <Panel>
                <h2 className="text-[15px] font-extrabold">{tw('review.funnel')}</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="pw-pipeline">{t('form.pipeline')}</Label>
                    {pick(pipelineId, setPipelineId, pipelines, 'pw-pipeline')}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pw-entry">{t('form.entryStage')}</Label>
                    {pick(entryStage, setEntryStage, stages, 'pw-entry')}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pw-qualified">{t('form.qualifiedStage')}</Label>
                    {pick(qualifiedStage, setQualifiedStage, stages, 'pw-qualified')}
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">{tw('review.dealHint')}</p>
              </Panel>
              <Panel>
                <Label htmlFor="pw-legal">{t('form.legal')}</Label>
                <Textarea
                  id="pw-legal"
                  value={legal}
                  onChange={(e) => {
                    setLegal(e.target.value);
                    setLegalTouched(true);
                  }}
                  rows={2}
                />
              </Panel>
            </>
          )}
        </div>

        <aside className="space-y-4">
          <Panel>
            <p className="text-muted-foreground text-xs font-bold tracking-[0.06em] uppercase">{tw('aside.leads')}</p>
            <p className="text-[44px] leading-none font-extrabold tracking-[-0.03em] tabular-nums">{leads}</p>
            {source === 'file' && hasNiches && (
              <p className="text-muted-foreground text-sm">
                {tw('aside.niches', { count: [...picked].filter((n) => n !== '').length })}
              </p>
            )}
            {step >= 1 && (
              <dl className="space-y-2 border-t pt-3 text-sm">
                <AsideRow label={tw('aside.channel')} value={isCloud ? t('channel.cloud') : `${t('channel.waha')} — ${wahaChannel?.name ?? ''}`} />
                {step >= 2 && (
                  <AsideRow label={tw('aside.duration')} value={days ? tw('aside.days', { count: days }) : '—'} />
                )}
                {step >= 2 && isCloud && costTotal !== null && (
                  <AsideRow label={tw('aside.cost')} value={`≈ ${money(costTotal)}`} />
                )}
              </dl>
            )}
          </Panel>

          {step === 1 && isCloud && template && (
            <Panel>
              <p className="text-[13px] font-bold">{tw('message.preview')}</p>
              {sample && (
                <p className="text-muted-foreground text-xs">
                  {sample.company || sample.name} · {sample.niche ?? sample.phone}
                </p>
              )}
              <div className="rounded-2xl bg-[#0f1a17] p-3.5">
                <p className="ml-auto max-w-[92%] rounded-[14px_14px_4px_14px] bg-[#134d37] px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-[#e9f5ef]">
                  {renderBody(template.body_text, templateParams, sample)}
                </p>
              </div>
            </Panel>
          )}

          {step === 1 && !isCloud && (
            <Panel>
              <p className="text-[13px] font-bold">{tw('message.preview')}</p>
              <p className="text-muted-foreground text-xs leading-relaxed">{tw('message.wahaPreview')}</p>
            </Panel>
          )}

          {(source === 'file' ? origin === 'public_business' : true) && !isCloud && step >= 1 && (
            <div className="bg-tone-salmon-soft text-tone-salmon-ink flex gap-3 rounded-[22px] p-4 text-[13px] leading-relaxed">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{tw('aside.coldWaha')}</p>
            </div>
          )}

          {step === 3 && (
            <Button className="h-12 w-full text-[15px] font-extrabold" disabled={busy || !stepOk.every(Boolean)} onClick={() => void start()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('start')}
            </Button>
          )}
          {step === 3 && <p className="text-muted-foreground text-center text-xs">{tw('review.firstNow')}</p>}
        </aside>
      </div>

      <div className="flex items-center justify-between border-t pt-4">
        {step === 0 ? (
          <Link href="/prospecting" className="text-muted-foreground text-sm font-semibold">
            {t('cancel')}
          </Link>
        ) : (
          <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
            <ArrowLeft className="size-4" />
            {tw(`steps.${STEPS[step - 1]}`)}
          </Button>
        )}
        {step < STEPS.length - 1 && (
          <Button disabled={!stepOk[step]} onClick={() => setStep((s) => s + 1)}>
            {tw('next', { step: tw(`steps.${STEPS[step + 1]}`) })}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The template body as the lead will read it. */
function renderBody(body: string, tokens: string[], sample: PlannedRow | null) {
  const values = renderTemplateParams(tokens, {
    name: sample?.name ?? null,
    company: sample?.company ?? null,
  });
  return body.replace(/\{\{(\d+)\}\}/g, (m, n) => values[Number(n) - 1] ?? m);
}

function Panel({ children }: { children: ReactNode }) {
  return <section className="border-border bg-card space-y-3.5 rounded-[22px] border p-5">{children}</section>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted rounded-xl px-3 py-2.5">
      <div className="text-muted-foreground truncate text-[11.5px] font-semibold">{label}</div>
      <div className="truncate text-sm font-extrabold tabular-nums">{value}</div>
    </div>
  );
}

function Row({ dot, label, hint, value }: { dot: string; label: string; hint?: string; value: number }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className={`size-2.5 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1">
        {label}
        {hint && <span className="text-muted-foreground"> · {hint}</span>}
      </span>
      <span className="font-extrabold tabular-nums">{value}</span>
    </li>
  );
}

function AsideRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-bold">{value}</dd>
    </div>
  );
}

function ChannelCard({ value, active, title, hint }: { value: string; active: boolean; title: string; hint: string }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-2xl border p-3.5 ${active ? 'border-tone-lilac bg-tone-lilac-soft' : ''}`}>
      <RadioGroupItem value={value} className="mt-0.5" />
      <span>
        <span className="block text-[13px] font-bold">{title}</span>
        <span className="text-muted-foreground block text-xs">{hint}</span>
      </span>
    </label>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function FollowupFields({
  t,
  isCloud,
  enabled,
  onEnabled,
  days,
  onDays,
  max,
  onMax,
  children,
}: {
  t: T;
  isCloud: boolean;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  days: number;
  onDays: (n: number) => void;
  max: number;
  onMax: (n: number) => void;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-2xl border p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold">{t('form.followup')}</p>
          <p className="text-muted-foreground text-xs">{isCloud ? t('form.followupCloudHint') : t('form.followupWahaHint')}</p>
        </div>
        <Switch checked={enabled} onCheckedChange={onEnabled} />
      </div>
      {enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField id="pw-fu-days" label={t('form.followupDays')} value={days} min={1} max={14} onChange={onDays} />
          <NumberField id="pw-fu-max" label={t('form.followupMax')} value={max} min={1} max={2} onChange={onMax} />
          {children && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('form.followupTemplate')}</Label>
              {children}
            </div>
          )}
        </div>
      )}
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
  /** Already sized to the template's variable count. */
  params: string[];
  onParams: (p: string[]) => void;
  t: T;
}) {
  const setAt = (i: number, v: string) => onParams(params.map((x, j) => (j === i ? v : x)));

  return (
    <div className="space-y-2.5">
      <Select value={value || null} onValueChange={(v) => onChange(v ?? '')}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={t('form.pick')}>
            {(v: string) => v?.replace('|', ' · ') || t('form.pick')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {templates.map((x) => (
            <SelectItem key={keyOf(x)} value={keyOf(x)}>
              {x.name} · {x.language}
              {x.category ? ` · ${x.category}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {loaded && templates.length === 0 && <p className="text-tone-salmon-ink text-xs">{t('form.noTemplates')}</p>}
      {params.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="bg-tone-lilac-soft text-tone-lilac-ink rounded-md px-2 py-0.5 text-xs font-bold">{`{{${i + 1}}}`}</span>
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
          {!(TOKENS as readonly string[]).includes(p) && <Input value={p} onChange={(e) => setAt(i, e.target.value)} />}
        </div>
      ))}
    </div>
  );
}
