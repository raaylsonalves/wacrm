'use client';

import { SubscribersPanel } from '@/components/operator/subscribers-panel';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { switchAccount, useOperator } from '@/hooks/use-operator';
import { attentionScore, type PortfolioRow } from '@/lib/operator/portfolio';
import { MODULES, MODULE_PRESETS } from '@/lib/account/modules';
import { AgencyTeam } from '@/components/operator/agency-team';
import { GoogleOAuthSettings } from '@/components/operator/google-oauth-settings';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCards } from '@/components/ui/skeleton';

/**
 * Operator portfolio (migration 090): one card per client account the
 * operator runs, with health and counts only — never message or contact
 * content. Sorted by what needs attention first.
 */
export default function OperatorPage() {
  const t = useTranslations('Operator');
  const { isOperator } = useOperator();
  const [rows, setRows] = useState<PortfolioRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [modules, setModules] = useState<Record<string, string[] | null>>({});

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: mods } = await supabase.rpc('operator_account_modules');
    setModules(
      Object.fromEntries(
        (
          (mods ?? []) as { account_id: string; modules: string[] | null }[]
        ).map((m) => [m.account_id, m.modules])
      )
    );
    const { data } = await supabase.rpc('operator_portfolio');
    setRows(
      ((data ?? []) as PortfolioRow[]).sort(
        (a, b) =>
          attentionScore(b) - attentionScore(a) || a.name.localeCompare(b.name)
      )
    );
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function enter(id: string) {
    setBusyId(id);
    const err = await switchAccount(id);
    if (err) {
      setBusyId(null);
      toast.error(t('switchFailed'));
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    const { data, error } = await createClient().rpc('create_client_account', {
      p_name: name,
    });
    setCreating(false);
    if (error || !data) {
      toast.error(t('createFailed'));
      return;
    }
    toast.success(t('created', { name }));
    setNewName('');
    await enter(data as string);
  }

  if (!isOperator && rows !== null && rows.length === 0) {
    return (
      <p className="text-muted-foreground p-8 text-center text-sm">
        {t('notOperator')}
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-foreground flex items-center gap-2 text-[26px] leading-tight font-bold tracking-[-0.02em] lg:text-[28px]">
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>

      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('newPlaceholder')}
          maxLength={120}
        />
        <Button type="submit" disabled={creating || !newName.trim()}>
          {creating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {t('newClient')}
        </Button>
      </form>

      <SubscribersPanel />

      <GoogleOAuthSettings />

      <AgencyTeam
        clients={(rows ?? [])
          .filter((r) => !r.is_home)
          .map((r) => ({ id: r.account_id, name: r.name }))}
      />

      {rows === null ? (
        <SkeletonCards count={4} className="md:grid-cols-2 lg:grid-cols-2" />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rows.map((r) => {
            const alerts = alertsOf(r, t);
            return (
              <div
                key={r.account_id}
                className={cn(
                  'bg-card space-y-3 rounded-xl border p-4',
                  alerts.length > 0 && 'border-amber-500/50'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-foreground truncate font-semibold">
                      {r.name}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {r.is_home ? t('home') : t('client')}
                      {r.last_inbound_at &&
                        ` · ${t('lastInbound', {
                          when: formatDistanceToNow(
                            new Date(r.last_inbound_at),
                            {
                              addSuffix: true,
                              locale: dateFnsLocale,
                            }
                          ),
                        })}`}
                    </p>
                  </div>
                  {r.is_active ? (
                    <span className="bg-primary/10 text-primary shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
                      {t('active')}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busyId}
                      onClick={() => void enter(r.account_id)}
                    >
                      {busyId === r.account_id && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      {t('enter')}
                    </Button>
                  )}
                </div>

                {alerts.length > 0 && (
                  <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                    {alerts.map((a) => (
                      <li key={a}>• {a}</li>
                    ))}
                  </ul>
                )}

                {!r.is_home && r.account_id in modules && (
                  <ModulesEditor
                    accountId={r.account_id}
                    value={modules[r.account_id]}
                    onChange={(v) =>
                      setModules((m) => ({ ...m, [r.account_id]: v }))
                    }
                  />
                )}

                <dl className="grid grid-cols-3 gap-2 text-center text-xs">
                  <Metric label={t('m.awaiting')} value={r.awaiting_reply} />
                  <Metric label={t('m.handoff')} value={r.handoff_waiting} />
                  <Metric label={t('m.cases')} value={r.open_cases} />
                  <Metric
                    label={t('m.appointments')}
                    value={r.appointments_today}
                  />
                  <Metric label={t('m.numbers')} value={numbersLabel(r)} />
                  <Metric
                    label={t('m.tokens')}
                    value={Number(r.tokens_7d).toLocaleString()}
                  />
                </dl>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function numbersLabel(r: PortfolioRow): string {
  const total = r.waha_total + (r.meta_status ? 1 : 0);
  const down =
    r.waha_down + (r.meta_status && r.meta_status !== 'connected' ? 1 : 0);
  return `${total - down}/${total}`;
}

function alertsOf(
  r: PortfolioRow,
  t: ReturnType<typeof useTranslations>
): string[] {
  const out: string[] = [];
  if (r.waha_down > 0) out.push(t('alert.wahaDown', { count: r.waha_down }));
  if (r.meta_status && r.meta_status !== 'connected')
    out.push(t('alert.metaDown'));
  if (!r.meta_status && r.waha_total === 0) out.push(t('alert.noNumber'));
  if (!r.ai_on) out.push(t('alert.aiOff'));
  if (r.handoff_waiting > 0)
    out.push(t('alert.handoff', { count: r.handoff_waiting }));
  if (r.owner_is_operator) out.push(t('alert.ownership'));
  return out;
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-muted/50 rounded-lg p-2">
      <dd className="text-foreground text-base font-semibold tabular-nums">
        {value}
      </dd>
      <dt className="text-muted-foreground">{label}</dt>
    </div>
  );
}

/**
 * What this client bought (migration 091). The client's own users see
 * only these; you, operating the account, always see everything.
 */
function ModulesEditor({
  accountId,
  value,
  onChange,
}: {
  accountId: string;
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const t = useTranslations('Operator.modules');
  const [saving, setSaving] = useState(false);

  async function save(next: string[] | null) {
    const prev = value;
    onChange(next);
    setSaving(true);
    const { error } = await createClient().rpc('set_account_modules', {
      p_account: accountId,
      p_modules: next,
    });
    setSaving(false);
    if (error) {
      onChange(prev);
      toast.error(t('saveFailed'));
    }
  }

  const on = (k: string) => value === null || value.includes(k);
  const toggle = (k: string) => {
    const base = value ?? [...MODULES];
    const next = base.includes(k) ? base.filter((x) => x !== k) : [...base, k];
    void save(next.length === MODULES.length ? null : next);
  };
  const preset = Object.entries(MODULE_PRESETS).find(
    ([, v]) =>
      (v === null && value === null) ||
      (v !== null &&
        value !== null &&
        v.length === value.length &&
        v.every((k) => value.includes(k)))
  )?.[0];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t('label')}</span>
        {Object.entries(MODULE_PRESETS).map(([key, v]) => (
          <button
            key={key}
            type="button"
            disabled={saving}
            onClick={() => void save(v)}
            className={cn(
              'rounded-full border px-2 py-0.5',
              preset === key
                ? 'border-primary bg-primary/10 text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {t(`preset.${key}`)}
          </button>
        ))}
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      <div className="flex flex-wrap gap-1">
        {MODULES.map((k) => (
          <button
            key={k}
            type="button"
            disabled={saving}
            onClick={() => toggle(k)}
            className={cn(
              'rounded-md border px-1.5 py-0.5 text-[11px]',
              on(k)
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground/60 border-dashed line-through'
            )}
          >
            {t(`key.${k}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
