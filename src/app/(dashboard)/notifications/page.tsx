'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowRightLeft,
  Bell,
  CalendarClock,
  CheckCheck,
  ClipboardList,
  Hand,
  Inbox,
  LayoutTemplate,
  Loader2,
  MessageCircle,
  Radio,
  Settings2,
  Timer,
  Trophy,
  UserPlus,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { renderNotification, type Translate } from '@/lib/notifications/render';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { Notification, NotificationType } from '@/types';

type Category = 'conversations' | 'sales' | 'system';
type Tab = 'all' | 'unread' | Category;

// Icon + tint per type. The category (tab) comes from the DB catalogue.
const TYPE_STYLE: Record<
  NotificationType,
  { icon: typeof Bell; tint: string }
> = {
  conversation_assigned: {
    icon: UserPlus,
    tint: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  },
  customer_replied: { icon: MessageCircle, tint: 'bg-primary/15 text-primary' },
  handoff_waiting: {
    icon: Hand,
    tint: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  sla_breached: {
    icon: Timer,
    tint: 'bg-red-500/15 text-red-600 dark:text-red-400',
  },
  new_unassigned: {
    icon: Inbox,
    tint: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  },
  case_opened: {
    icon: ClipboardList,
    tint: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  },
  case_lead_replied: {
    icon: ClipboardList,
    tint: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  },
  case_relay_failed: {
    icon: AlertTriangle,
    tint: 'bg-red-500/15 text-red-600 dark:text-red-400',
  },
  appointment_reminder: {
    icon: CalendarClock,
    tint: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  },
  deal_won: {
    icon: Trophy,
    tint: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  deal_lost: {
    icon: XCircle,
    tint: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  },
  deal_stage_changed: {
    icon: ArrowRightLeft,
    tint: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  },
  channel_disconnected: {
    icon: WifiOff,
    tint: 'bg-red-500/15 text-red-600 dark:text-red-400',
  },
  ai_provider_failed: {
    icon: AlertTriangle,
    tint: 'bg-red-500/15 text-red-600 dark:text-red-400',
  },
  template_status: {
    icon: LayoutTemplate,
    tint: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  },
  broadcast_finished: {
    icon: Radio,
    tint: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  },
};

interface TypeRow {
  type: NotificationType;
  category: Category;
  in_app_default: boolean;
  push_default: boolean;
  position: number;
}
interface PrefRow {
  type: NotificationType;
  in_app: boolean;
  push: boolean;
}

function dayBucket(iso: string): 'today' | 'yesterday' | 'earlier' {
  const d = new Date(iso);
  if (isToday(d)) return 'today';
  if (isYesterday(d)) return 'yesterday';
  return 'earlier';
}

export default function NotificationsPage() {
  const t = useTranslations('Notifications');
  const router = useRouter();
  const { accountId, user } = useAuth();
  const [notifications, setNotifications] = useState<Notification[] | null>(
    null
  );
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [prefsOpen, setPrefsOpen] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const [{ data, error: fetchErr }, { data: typeRows }] = await Promise.all([
      supabase
        .from('notifications')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(150),
      supabase.from('notification_types').select('*').order('position'),
    ]);
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    setNotifications((data ?? []) as Notification[]);
    setTypes((typeRows ?? []) as TypeRow[]);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Realtime: new rows, grouped rows bumped (UPDATE moves them to the
  // top), and read state from another tab or device.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('notifications-page')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications' },
        (payload) => {
          if (
            payload.eventType === 'INSERT' ||
            payload.eventType === 'UPDATE'
          ) {
            const row = payload.new as Notification;
            setNotifications((prev) => {
              const rest = (prev ?? []).filter((n) => n.id !== row.id);
              return [row, ...rest].sort((a, b) =>
                b.created_at.localeCompare(a.created_at)
              );
            });
          } else if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Partial<Notification>;
            setNotifications(
              (prev) => prev?.filter((n) => n.id !== oldRow.id) ?? prev
            );
          }
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const categoryOf = useMemo(() => {
    const m = new Map<string, Category>();
    for (const r of types) m.set(r.type, r.category);
    return m;
  }, [types]);

  const markRead = useCallback(
    async (id: string) => {
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at
              ? { ...n, read_at: new Date().toISOString() }
              : n
          ) ?? prev
      );
      const { error: updateErr } = await createClient()
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .is('read_at', null);
      if (updateErr) {
        toast.error(t('markReadFailed'));
        load();
      }
    },
    [load, t]
  );

  const handleClick = useCallback(
    (n: Notification) => {
      if (!n.read_at) void markRead(n.id);
      const href =
        n.link || (n.conversation_id ? `/inbox?c=${n.conversation_id}` : null);
      if (href) router.push(href);
    },
    [markRead, router]
  );

  const unreadCount = notifications?.filter((n) => !n.read_at).length ?? 0;

  const markAllRead = useCallback(async () => {
    if (unreadCount === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    setNotifications(
      (prev) =>
        prev?.map((n) => (n.read_at ? n : { ...n, read_at: now })) ?? prev
    );
    const { error: updateErr } = await createClient()
      .from('notifications')
      .update({ read_at: now })
      .is('read_at', null);
    setMarkingAll(false);
    if (updateErr) {
      toast.error(t('markAllFailed'));
      load();
    }
  }, [unreadCount, load, t]);

  const visible = useMemo(() => {
    const list = notifications ?? [];
    if (tab === 'all') return list;
    if (tab === 'unread') return list.filter((n) => !n.read_at);
    return list.filter(
      (n) => (categoryOf.get(n.type) ?? 'conversations') === tab
    );
  }, [notifications, tab, categoryOf]);

  const tabs: { key: Tab; count?: number }[] = [
    { key: 'all' },
    { key: 'unread', count: unreadCount },
    { key: 'conversations' },
    { key: 'sales' },
    { key: 'system' },
  ];

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-destructive text-sm">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  if (notifications === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPrefsOpen(true)}
          >
            <Settings2 className="h-4 w-4" />
            {t('preferences')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={unreadCount === 0 || markingAll}
            onClick={markAllRead}
          >
            {markingAll ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCheck className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">{t('markAllRead')}</span>
          </Button>
        </div>
      </div>

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {tabs.map(({ key, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
              tab === key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {t(`tabs.${key}`)}
            {count !== undefined && count > 0 && (
              <span
                className={cn(
                  'rounded-full px-1.5 text-[11px] leading-5 tabular-nums',
                  tab === key
                    ? 'bg-primary-foreground/20'
                    : 'bg-primary text-primary-foreground'
                )}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="border-border bg-muted/40 flex h-48 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-xl">
            <Bell className="text-primary h-6 w-6" />
          </div>
          <p className="text-foreground mt-3 text-sm font-medium">
            {tab === 'all' ? t('emptyTitle') : t('emptyFiltered')}
          </p>
          {tab === 'all' && (
            <p className="text-muted-foreground mt-1 text-xs">
              {t('emptyDesc')}
            </p>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((n, i) => {
            const style = TYPE_STYLE[n.type] ?? {
              icon: Bell,
              tint: 'bg-muted text-muted-foreground',
            };
            const Icon = style.icon;
            const isUnread = !n.read_at;
            const { title, body } = renderNotification(
              n,
              t as unknown as Translate
            );
            // A day heading above the first row of each day.
            const bucket = dayBucket(n.created_at);
            const header =
              i === 0 || dayBucket(visible[i - 1].created_at) !== bucket
                ? bucket
                : null;
            return (
              <li key={n.id}>
                {header && (
                  <h2 className="text-muted-foreground px-1 pt-2 pb-1 text-xs font-semibold tracking-wide uppercase">
                    {t(`days.${header}`)}
                  </h2>
                )}
                <button
                  type="button"
                  onClick={() => handleClick(n)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
                    isUnread
                      ? 'border-primary/30 bg-primary/5 hover:border-primary/50'
                      : 'border-border bg-card hover:bg-muted/40'
                  )}
                >
                  <div
                    className={cn(
                      'relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full',
                      style.tint
                    )}
                    aria-hidden
                  >
                    <Icon className="h-5 w-5" />
                    {(n.count ?? 1) > 1 && (
                      <span className="bg-foreground text-background absolute -top-1 -right-1 min-w-5 rounded-full px-1 text-center text-[10px] leading-5 font-bold tabular-nums">
                        {n.count}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className={cn(
                          'text-sm',
                          isUnread
                            ? 'text-foreground font-semibold'
                            : 'text-foreground/80 font-medium'
                        )}
                      >
                        {title}
                      </span>
                      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[11px]">
                        {formatDistanceToNow(new Date(n.created_at), {
                          addSuffix: false,
                          locale: dateFnsLocale,
                        })}
                        {isUnread && (
                          <span
                            aria-label={t('unread')}
                            className="bg-primary h-2 w-2 rounded-full"
                          />
                        )}
                      </span>
                    </div>
                    {body && (
                      <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                        {body}
                      </p>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <PreferencesDialog
        open={prefsOpen}
        onOpenChange={setPrefsOpen}
        types={types}
        userId={user?.id ?? null}
      />
    </div>
  );
}

function PreferencesDialog({
  open,
  onOpenChange,
  types,
  userId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  types: TypeRow[];
  userId: string | null;
}) {
  const t = useTranslations('Notifications');
  const [prefs, setPrefs] = useState<Map<string, PrefRow>>(() => new Map());

  useEffect(() => {
    if (!open || !userId) return;
    let alive = true;
    createClient()
      .from('notification_preferences')
      .select('type, in_app, push')
      .eq('user_id', userId)
      .then(({ data }) => {
        if (alive)
          setPrefs(
            new Map(((data ?? []) as PrefRow[]).map((p) => [p.type, p]))
          );
      });
    return () => {
      alive = false;
    };
  }, [open, userId]);

  const effective = (r: TypeRow): PrefRow =>
    prefs.get(r.type) ?? {
      type: r.type,
      in_app: r.in_app_default,
      push: r.push_default,
    };

  async function toggle(r: TypeRow, field: 'in_app' | 'push', value: boolean) {
    if (!userId) return;
    const next = { ...effective(r), [field]: value };
    // Push without the in-app row makes no sense to explain; keep them paired.
    if (field === 'in_app' && !value) next.push = false;
    if (field === 'push' && value) next.in_app = true;
    const before = prefs;
    setPrefs(new Map(prefs).set(r.type, next));
    const { error } = await createClient()
      .from('notification_preferences')
      .upsert(
        {
          user_id: userId,
          type: r.type,
          in_app: next.in_app,
          push: next.push,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,type' }
      );
    if (error) {
      setPrefs(before);
      toast.error(t('saveFailed'));
    }
  }

  const groups: Category[] = ['conversations', 'sales', 'system'];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('preferences')}</DialogTitle>
          <DialogDescription>{t('preferencesDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g} className="space-y-1">
              <div className="grid grid-cols-[1fr_4rem_4rem] items-end gap-2 px-1">
                <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  {t(`tabs.${g}`)}
                </h3>
                <span className="text-muted-foreground text-center text-[11px]">
                  {t('inApp')}
                </span>
                <span className="text-muted-foreground text-center text-[11px]">
                  {t('push')}
                </span>
              </div>
              {types
                .filter((r) => r.category === g)
                .map((r) => {
                  const p = effective(r);
                  return (
                    <div
                      key={r.type}
                      className="hover:bg-muted/40 grid grid-cols-[1fr_4rem_4rem] items-center gap-2 rounded-lg px-1 py-1.5"
                    >
                      <span className="text-sm">{t(`types.${r.type}`)}</span>
                      <span className="flex justify-center">
                        <Switch
                          checked={p.in_app}
                          onCheckedChange={(v) => void toggle(r, 'in_app', v)}
                          aria-label={`${t(`types.${r.type}`)} — ${t('inApp')}`}
                        />
                      </span>
                      <span className="flex justify-center">
                        <Switch
                          checked={p.push}
                          onCheckedChange={(v) => void toggle(r, 'push', v)}
                          aria-label={`${t(`types.${r.type}`)} — ${t('push')}`}
                        />
                      </span>
                    </div>
                  );
                })}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
