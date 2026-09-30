'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

interface Member {
  user_id: string;
  full_name: string | null;
  email: string;
  is_operator: boolean;
  account_ids: string[];
}

/**
 * The agency's people (migration 092): the owner turns teammates into
 * operators and picks which client each may enter. Renders nothing for
 * anyone who isn't the agency owner (the RPC returns no rows).
 */
export function AgencyTeam({
  clients,
}: {
  clients: { id: string; name: string }[];
}) {
  const t = useTranslations('Operator.team');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await createClient().rpc('agency_team');
    setMembers((data ?? []) as Member[]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(key: string, fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(key);
    const { error } = await fn();
    setBusy(null);
    if (error) toast.error(t('failed'));
    await load();
  }

  if (!members || members.length === 0) return null;
  const supabase = createClient();

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
          <Users className="text-primary h-5 w-5" />
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {members.map((m) => (
          <li
            key={m.user_id}
            className="bg-card space-y-2 rounded-xl border p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm font-medium">
                  {m.full_name || m.email}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {m.email}
                </p>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run(m.user_id, () =>
                    supabase.rpc('set_agency_operator', {
                      p_user: m.user_id,
                      p_on: !m.is_operator,
                    })
                  )
                }
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs',
                  m.is_operator
                    ? 'border-primary bg-primary/10 text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted'
                )}
              >
                {busy === m.user_id && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {m.is_operator ? t('operator') : t('makeOperator')}
              </button>
            </div>
            {m.is_operator && (
              <div className="flex flex-wrap gap-1">
                {clients.length === 0 && (
                  <span className="text-muted-foreground text-xs">
                    {t('noClients')}
                  </span>
                )}
                {clients.map((c) => {
                  const on = m.account_ids.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(m.user_id + c.id, () =>
                          supabase.rpc('set_operator_assignment', {
                            p_user: m.user_id,
                            p_account: c.id,
                            p_on: !on,
                          })
                        )
                      }
                      className={cn(
                        'rounded-md border px-1.5 py-0.5 text-[11px]',
                        on
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground/60 border-dashed'
                      )}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
