'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { ClipboardList, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';

type View = 'team' | 'customer' | 'closed';
interface CaseListRow {
  id: string;
  title: string;
  blocker: string;
  status: string;
  opened_by: 'ai' | 'system' | 'human';
  claimed_by: string | null;
  relay_status: string | null;
  opened_at: string;
  updated_at: string;
  conversation_id: string;
  contact: { name: string | null; phone: string } | null;
}
interface CaseEvent {
  id: string;
  kind: string;
  actor_kind: string;
  body: string | null;
  created_at: string;
}
interface CaseDetail extends CaseListRow {
  summary: string;
  excerpt: string | null;
  pending_note: string | null;
}

/**
 * Human cases (specs/human-cases.md): the tasks the AI could not do itself.
 * The AI keeps talking to the customer; the team does the task here and
 * the AI relays the outcome.
 */
export default function CasesPage() {
  const t = useTranslations('Cases');
  const canAct = useCan('send-messages');
  const [view, setView] = useState<View>('team');
  const [rows, setRows] = useState<CaseListRow[] | null>(null);
  const [counts, setCounts] = useState({ team: 0, customer: 0 });
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const { accountId } = useAuth();

  // Live: a case opened by the AI, claimed by a teammate or closed by the
  // customer's reply refreshes the list (migration 093). Bursts collapse
  // into one reload.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(`cases-${accountId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'human_cases',
          filter: `account_id=eq.${accountId}`,
        },
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(reload, 400);
        }
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [accountId, reload]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/cases?view=${view}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { cases: [], counts: { team: 0, customer: 0 } }))
      .then((d) => {
        if (!alive) return;
        setRows(d.cases ?? []);
        setCounts(d.counts ?? { team: 0, customer: 0 });
      })
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [view, reloadKey]);

  const tabs: { key: View; label: string; count?: number }[] = [
    { key: 'team', label: t('views.team'), count: counts.team },
    { key: 'customer', label: t('views.customer'), count: counts.customer },
    { key: 'closed', label: t('views.closed') },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground max-w-2xl text-sm">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Button
            key={tab.key}
            size="sm"
            variant={view === tab.key ? 'default' : 'outline'}
            onClick={() => {
              setRows(null);
              setView(tab.key);
            }}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="bg-background/20 ml-1 rounded-full px-1.5 text-[10px] tabular-nums">{tab.count}</span>
            )}
          </Button>
        ))}
      </div>

      {rows === null ? (
        <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <ClipboardList className="size-8 opacity-40" />
            <p>{t(`empty.${view}`)}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="divide-border overflow-hidden rounded-lg border">
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpenId(r.id)}
              className="hover:bg-muted/50 flex w-full flex-col gap-1 border-b px-4 py-3 text-left last:border-b-0"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="text-foreground font-medium">{r.title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {formatDistanceToNow(new Date(view === 'closed' ? r.updated_at : r.opened_at), {
                    addSuffix: true,
                    locale: dateFnsLocale,
                  })}
                </span>
              </div>
              <span className="text-muted-foreground line-clamp-2 text-sm">{r.blocker}</span>
              <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <span>{r.contact?.name || r.contact?.phone}</span>
                {r.opened_by === 'system' && (
                  <span className="rounded-full border border-amber-400 px-1.5 text-amber-700 dark:text-amber-300">
                    {t('failSafe')}
                  </span>
                )}
                {(r.relay_status === 'window_closed' || r.relay_status === 'failed') && (
                  <span className="rounded-full border border-red-400 px-1.5 text-red-700 dark:text-red-300">
                    {t('notRelayed')}
                  </span>
                )}
                {view === 'closed' && <span>{t(`status.${r.status}`)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      <CaseSheet id={openId} canAct={canAct} onClose={() => setOpenId(null)} onChanged={reload} />
    </div>
  );
}

function CaseSheet({
  id,
  canAct,
  onClose,
  onChanged,
}: {
  id: string | null;
  canAct: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Cases');
  const [data, setData] = useState<{ case: CaseDetail; events: CaseEvent[] } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    fetch(`/api/cases/${id}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [id]);

  async function act(action: 'claim' | 'done' | 'need_info' | 'escalate' | 'cancel') {
    if (!id) return;
    setBusy(action);
    try {
      const res = await fetch(`/api/cases/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t.has(`errors.${d.error}`) ? t(`errors.${d.error}`) : t('errors.generic'));
        return;
      }
      toast.success(t(`done.${action}`));
      setNote('');
      onChanged();
      if (action !== 'claim') onClose();
    } finally {
      setBusy(null);
    }
  }

  const c = data?.case;
  const open = c && (c.status === 'awaiting_human' || c.status === 'awaiting_lead');

  return (
    <Sheet
      open={!!id}
      onOpenChange={(v) => {
        if (!v) {
          setData(null);
          onClose();
        }
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {!c ? (
          <Loader2 className="text-muted-foreground mx-auto mt-10 size-6 animate-spin" />
        ) : (
          <div className="space-y-5 p-4">
            <SheetHeader className="p-0">
              <SheetTitle>{c.title}</SheetTitle>
              <SheetDescription>
                {c.contact?.name || c.contact?.phone} · {t(`status.${c.status}`)}
              </SheetDescription>
            </SheetHeader>

            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase">{t('detail.blocker')}</h3>
              <p className="text-sm">{c.blocker}</p>
            </section>
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase">{t('detail.summary')}</h3>
              <p className="text-sm whitespace-pre-wrap">{c.summary}</p>
            </section>
            {c.excerpt && (
              <section className="space-y-1">
                <h3 className="text-xs font-semibold uppercase">{t('detail.excerpt')}</h3>
                <pre className="bg-muted/50 max-h-48 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">{c.excerpt}</pre>
                <Link href={`/inbox?c=${c.conversation_id}`} className="text-primary text-xs underline">
                  {t('detail.openConversation')}
                </Link>
              </section>
            )}

            {open && canAct && (
              <section className="space-y-2 rounded-md border p-3">
                <h3 className="text-sm font-medium">{t('detail.respond')}</h3>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder={t('detail.notePlaceholder')}
                />
                <p className="text-muted-foreground text-xs">{t('detail.noteHint')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={!!busy || note.trim().length < 2} onClick={() => act('done')}>
                    {busy === 'done' && <Loader2 className="size-3.5 animate-spin" />}
                    {t('actions.done')}
                  </Button>
                  {c.status === 'awaiting_human' && (
                    <Button size="sm" variant="outline" disabled={!!busy || note.trim().length < 2} onClick={() => act('need_info')}>
                      {t('actions.need_info')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act('escalate')}>
                    {t('actions.escalate')}
                  </Button>
                  {!c.claimed_by && (
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act('claim')}>
                      {t('actions.claim')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act('cancel')}>
                    {t('actions.cancel')}
                  </Button>
                </div>
              </section>
            )}

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase">{t('detail.timeline')}</h3>
              <ol className="space-y-2">
                {data!.events.map((e) => (
                  <li key={e.id} className="text-sm">
                    <span className="font-medium">{t.has(`events.${e.kind}`) ? t(`events.${e.kind}`) : e.kind}</span>
                    <span className="text-muted-foreground">
                      {' · '}
                      {t(`actor.${e.actor_kind}`)} ·{' '}
                      {formatDistanceToNow(new Date(e.created_at), { addSuffix: true, locale: dateFnsLocale })}
                    </span>
                    {e.body && (
                      <p className={cn('text-muted-foreground text-xs whitespace-pre-wrap')}>{e.body}</p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
