'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Briefcase, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { switchAccount, useOperator } from '@/hooks/use-operator';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * For platform operators only (renders nothing for everyone else):
 *
 * - While inside a client's account, a persistent banner "Operando:
 *   <client> · Voltar para minha conta". Sending as the wrong business is
 *   the worst failure of operator mode; the banner is the mitigation.
 * - The stale-tab guard: the active account lives on the profile, shared
 *   by every tab. When this tab comes back to focus and the profile now
 *   points elsewhere (switched in another tab), a blocking dialog asks to
 *   reload before anything is written to the wrong account.
 */
export function OperatorBanner() {
  const t = useTranslations('Operator.banner');
  const { account, accountId, user } = useAuth();
  const { isOperator, homeAccountId } = useOperator();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!isOperator || !user || !accountId) return;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const { data } = await createClient()
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (data && data.account_id !== accountId) setStale(true);
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [isOperator, user, accountId]);

  if (!isOperator) return null;

  const operating =
    !!accountId && !!homeAccountId && accountId !== homeAccountId;
  const name = account?.display_name || account?.name || '';

  return (
    <>
      {operating && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-violet-600 px-4 py-1.5 text-xs text-white">
          <Briefcase className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t('operating')} <strong>{name}</strong>
          </span>
          <Link href="/operator" className="underline-offset-2 hover:underline">
            {t('portfolio')}
          </Link>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!homeAccountId) return;
              setBusy(true);
              const err = await switchAccount(homeAccountId);
              if (err) {
                setBusy(false);
                toast.error(t('switchFailed'));
              }
            }}
            className="rounded bg-white/15 px-2 py-0.5 font-medium hover:bg-white/25"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              t('backHome')
            )}
          </button>
        </div>
      )}

      <Dialog open={stale}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('staleTitle')}</DialogTitle>
            <DialogDescription>{t('staleBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => window.location.assign('/dashboard')}>
              {t('reload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
