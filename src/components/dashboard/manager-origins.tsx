'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';

interface OriginRow {
  source: string;
  label: string;
  leads: number;
  deals_won: number;
  won_value: number | string;
}
interface LossRow {
  reason: string;
  deals: number;
  lost_value: number | string;
}

/**
 * Where leads came from and why deals were lost, in the Equipe tab's
 * period (migration 134). Two plain tables: a manager reads "Instagram
 * brought 40 and sold 3" and "8 lost on price" and decides what to do.
 */
export function ManagerOrigins({ from, to }: { from: Date; to: Date }) {
  const t = useTranslations('Manager.origins');
  const tl = useTranslations('Pipelines.loss');
  const { accountId, defaultCurrency } = useAuth();
  const [origins, setOrigins] = useState<OriginRow[] | null>(null);
  const [losses, setLosses] = useState<LossRow[] | null>(null);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  useEffect(() => {
    if (!accountId) return;
    const db = createClient();
    const args = { p_account_id: accountId, p_from: fromIso, p_to: toIso };
    void Promise.all([db.rpc('lead_origin_report', args), db.rpc('loss_report', args)]).then(([o, l]) => {
      if (o.error || l.error) console.error('[manager origins] load failed:', o.error ?? l.error);
      setOrigins((o.data as OriginRow[]) ?? []);
      setLosses((l.data as LossRow[]) ?? []);
    });
  }, [accountId, fromIso, toIso]);

  const lossTotal = (losses ?? []).reduce((s, r) => s + Number(r.deals), 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section aria-labelledby="mgr-origins" className="border-border bg-card flex flex-col gap-3 rounded-[24px] border p-5">
        <h2 id="mgr-origins" className="text-lg font-extrabold">{t('title')}</h2>
        {!origins ? (
          <div className="bg-muted h-32 animate-pulse rounded-[18px]" />
        ) : origins.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th className="py-2 font-bold">{t('col.origin')}</th>
                <th className="py-2 text-right font-bold">{t('col.leads')}</th>
                <th className="py-2 text-right font-bold">{t('col.won')}</th>
                <th className="py-2 text-right font-bold">{t('col.value')}</th>
              </tr>
            </thead>
            <tbody>
              {origins.map((r) => (
                <tr key={`${r.source}:${r.label}`} className="border-border border-t">
                  <td className="py-2.5">
                    <span className="font-bold">{t(`source.${r.source}`)}</span>
                    {r.label && <span className="text-muted-foreground"> · {r.label}</span>}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{r.leads}</td>
                  <td className="py-2.5 text-right tabular-nums">{r.deals_won}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatCurrency(Number(r.won_value), defaultCurrency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-muted-foreground text-[13px]">{t('hint')}</p>
      </section>

      <section aria-labelledby="mgr-losses" className="border-border bg-card flex flex-col gap-3 rounded-[24px] border p-5">
        <h2 id="mgr-losses" className="text-lg font-extrabold">{t('lossTitle')}</h2>
        {!losses ? (
          <div className="bg-muted h-32 animate-pulse rounded-[18px]" />
        ) : losses.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('lossEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {losses.map((r) => {
              const pct = lossTotal ? Math.round((Number(r.deals) / lossTotal) * 100) : 0;
              return (
                <li key={r.reason} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-bold">
                      {r.reason === 'unknown' ? tl('reasonMissing') : tl(`reason.${r.reason}`)}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {r.deals} · {formatCurrency(Number(r.lost_value), defaultCurrency)}
                    </span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div className="bg-tone-pink-ink h-full rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
