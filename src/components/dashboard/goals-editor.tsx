'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { SidePanel } from '@/components/ui/side-panel';
import { cn } from '@/lib/utils';
import { GOAL_METRICS, findGoal, type GoalMetric, type GoalPeriod, type GoalRow } from '@/lib/dashboard/goals';

const PERIODS: GoalPeriod[] = ['day', 'month'];
const TEAM = '__team__';

/**
 * Admins set daily / monthly targets per person and for the whole team
 * (migration 136). One metric at a time keeps the table narrow enough
 * for a phone; an empty box means "no goal".
 */
export function GoalsEditor({
  open,
  members,
  goals,
  onClose,
  onSaved,
}: {
  open: boolean;
  members: { userId: string; name: string }[];
  goals: GoalRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Manager.goals');
  return (
    <SidePanel open={open} onClose={onClose} label={t('edit')}>
      {open && <Editor members={members} goals={goals} onClose={onClose} onSaved={onSaved} />}
    </SidePanel>
  );
}

function Editor({
  members,
  goals,
  onClose,
  onSaved,
}: {
  members: { userId: string; name: string }[];
  goals: GoalRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Manager.goals');
  const { accountId } = useAuth();
  const [metric, setMetric] = useState<GoalMetric>('won_value');
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    for (const m of GOAL_METRICS)
      for (const p of PERIODS)
        for (const who of [TEAM, ...members.map((x) => x.userId)]) {
          const v = findGoal(goals, who === TEAM ? null : who, m, p);
          if (v !== null) d[`${m}:${p}:${who}`] = String(v);
        }
    return d;
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!accountId) return;
    setSaving(true);
    const db = createClient();
    const rows = Object.entries(draft)
      .map(([key, value]) => {
        const [m, p, who] = key.split(':');
        const target = Number(value.replace(',', '.'));
        return { account_id: accountId, user_id: who === TEAM ? null : who, metric: m, period: p, target };
      })
      .filter((r) => r.target > 0);
    // Replace the account's goals wholesale: simpler than diffing, and
    // the expression unique index can't drive an upsert.
    const del = await db.from('team_goals').delete().eq('account_id', accountId);
    const ins = del.error || rows.length === 0 ? { error: del.error } : await db.from('team_goals').insert(rows);
    setSaving(false);
    if (del.error || ins.error) {
      console.error('[goals] save failed:', del.error ?? ins.error);
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('saved'));
    onSaved();
    onClose();
  }

  const people = [{ userId: TEAM, name: t('wholeTeam') }, ...members];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-5 pt-4 pb-2">
        <h2 className="flex-1 text-lg font-extrabold">{t('edit')}</h2>
        <button type="button" onClick={onClose} aria-label={t('close')} className="hover:bg-muted flex size-9 items-center justify-center rounded-full">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
        <div role="tablist" aria-label={t('metricLabel')} className="flex flex-wrap gap-1.5">
          {GOAL_METRICS.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={metric === m}
              onClick={() => setMetric(m)}
              className={cn(
                'min-h-9 rounded-full border px-3 text-[13px] font-semibold',
                metric === m ? 'bg-foreground text-background border-transparent' : 'border-border hover:bg-muted'
              )}
            >
              {t(`metric.${m}`)}
            </button>
          ))}
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-xs">
              <th className="py-2 font-bold">{t('who')}</th>
              {PERIODS.map((p) => (
                <th key={p} className="w-28 py-2 font-bold">{t(`period.${p}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.userId} className="border-border border-t">
                <td className={cn('py-2 pr-2', person.userId === TEAM && 'font-bold')}>{person.name}</td>
                {PERIODS.map((p) => {
                  const key = `${metric}:${p}:${person.userId}`;
                  return (
                    <td key={p} className="py-2 pr-1">
                      <input
                        inputMode="decimal"
                        value={draft[key] ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value.replace(/[^\d.,]/g, '') }))}
                        placeholder="—"
                        aria-label={`${person.name} · ${t(`period.${p}`)}`}
                        className="border-border bg-card-2 w-full rounded-lg border px-2 py-1.5 text-right tabular-nums outline-none focus:border-foreground/30"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted-foreground text-[13px]">{t('hint')}</p>
      </div>
      <div className="border-border flex justify-end gap-2 border-t px-5 py-3">
        <button type="button" onClick={onClose} className="hover:bg-muted min-h-10 rounded-full px-4 text-[13px] font-semibold">
          {t('cancel')}
        </button>
        <button type="button" onClick={() => void save()} disabled={saving} className="bg-foreground text-background min-h-10 rounded-full px-5 text-[13px] font-bold disabled:opacity-50">
          {t('save')}
        </button>
      </div>
    </div>
  );
}
