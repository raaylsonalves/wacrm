'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  CalendarDays,
  CircleDollarSign,
  Home,
  Menu,
  MessageCircle,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useModules } from '@/hooks/use-modules';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/dashboard', key: 'dashboard', icon: Home },
  { href: '/inbox', key: 'inbox', icon: MessageCircle },
  { href: '/pipelines', key: 'deals', icon: CircleDollarSign },
  { href: '/agenda', key: 'agenda', icon: CalendarDays },
] as const;

/**
 * Phone tab bar (Dashboard / Conversations / Deals / Agenda / More). Below lg
 * only — desktop keeps the sidebar. Hidden inside an open conversation so
 * the composer gets the full height, like WhatsApp. While it shows it sets
 * `data-bottom-nav="on"` on <html>, which globals.css turns into the
 * `--bottom-nav` height full-height pages subtract.
 */
function BottomNavInner({ onMore }: { onMore: () => void }) {
  const t = useTranslations('BottomNav');
  const pathname = usePathname();
  const params = useSearchParams();
  const { accountId } = useAuth();
  const { allowed } = useModules();
  const inThread = pathname.startsWith('/inbox') && params.has('c');
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.bottomNav = inThread ? 'off' : 'on';
    return () => {
      delete root.dataset.bottomNav;
    };
  }, [inThread]);

  // Conversations with unread customer messages — refreshed on every
  // navigation and once a minute; cheap (head-only count).
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    const load = () =>
      createClient()
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .neq('status', 'closed')
        .gt('unread_count', 0)
        .then(({ count }) => {
          if (alive) setUnread(count ?? 0);
        });
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [accountId, pathname]);

  if (inThread) return null;

  return (
    <nav
      aria-label={t('label')}
      className="shrink-0 px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:hidden"
    >
      <div className="border-border bg-card/95 supports-backdrop-filter:bg-card/85 flex items-stretch gap-1 rounded-full border p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.08)] backdrop-blur">
      {TABS.filter((tab) => allowed(tab.href)).map(({ href, key, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[10.5px] font-semibold transition-colors duration-150 ease-out',
              active ? 'bg-foreground text-background' : 'text-muted-foreground'
            )}
          >
            <span className="relative">
              <Icon className="h-[18px] w-[18px]" />
              {key === 'inbox' && unread > 0 && (
                <span className="bg-tone-salmon text-tone-on absolute -top-1.5 -right-2.5 min-w-4.5 rounded-full px-1 text-center text-[10px] leading-4.5 font-bold tabular-nums">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </span>
            {t(key)}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        className="text-muted-foreground flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[10.5px] font-semibold"
      >
        <Menu className="h-[18px] w-[18px]" />
        {t('more')}
      </button>
      </div>
    </nav>
  );
}

export function BottomNav({ onMore }: { onMore: () => void }) {
  // useSearchParams needs a Suspense boundary under the App Router.
  return (
    <Suspense fallback={null}>
      <BottomNavInner onMore={onMore} />
    </Suspense>
  );
}
