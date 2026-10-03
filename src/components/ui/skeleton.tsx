'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { TableCell, TableRow } from '@/components/ui/table';

/**
 * Loading placeholders in the shape of what's coming (v2 motion guide):
 * a soft shimmer across warm blocks instead of a spinner in the middle of
 * the page. "Reduce motion" leaves them still (globals.css).
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-shimmer rounded-xl bg-[linear-gradient(90deg,var(--muted)_0%,var(--card-2)_50%,var(--muted)_100%)] bg-[length:200%_100%]',
        className
      )}
    />
  );
}

/** Announces "loading" once for screen readers; the blocks are hidden. */
function Busy({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations('DashboardShell');
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{t('loading')}</span>
      {children}
    </div>
  );
}

/** Rows with an avatar and two lines — conversations, cases, campaigns. */
export function SkeletonList({
  rows = 5,
  avatar = true,
  bare = false,
  className,
}: {
  rows?: number;
  avatar?: boolean;
  /** No card around the rows (when the parent already is one). */
  bare?: boolean;
  className?: string;
}) {
  return (
    <Busy
      className={cn(
        !bare && 'border-border bg-card rounded-[20px] border p-2',
        'flex flex-col gap-1',
        className
      )}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2.5 py-2.5">
          {avatar && <Skeleton className="size-10 shrink-0 rounded-full" />}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 rounded-full" />
            <Skeleton
              className={cn('h-3 rounded-full', i % 2 ? 'w-2/3' : 'w-5/6')}
            />
          </div>
        </div>
      ))}
    </Busy>
  );
}

/** A grid of cards — templates, flows, accounts, KPI tiles. */
export function SkeletonCards({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <Busy
      className={cn(
        'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4',
        className
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="border-border bg-card flex flex-col gap-3 rounded-[20px] border p-4"
        >
          <Skeleton className="size-9 rounded-full" />
          <Skeleton className="h-3.5 w-3/4 rounded-full" />
          <Skeleton className="h-3 w-1/2 rounded-full" />
        </div>
      ))}
    </Busy>
  );
}

/** Placeholder rows inside an existing <TableBody>. */
export function SkeletonTableRows({
  rows = 6,
  cols = 4,
}: {
  rows?: number;
  cols?: number;
}) {
  const t = useTranslations('DashboardShell');
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <TableRow
          key={r}
          className="border-border hover:bg-transparent"
          aria-hidden={r > 0 || undefined}
        >
          {Array.from({ length: cols }, (_, c) => (
            <TableCell key={c} className="py-3.5">
              {r === 0 && c === 0 && (
                <span className="sr-only">{t('loading')}</span>
              )}
              <Skeleton
                className={cn(
                  'h-3.5 rounded-full',
                  c === 0 ? 'w-36' : c % 2 ? 'w-24' : 'w-16'
                )}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/**
 * Whole-page placeholder for pages that render nothing until their data
 * arrives: the heading block plus the body in the page's own shape.
 */
export function SkeletonPage({
  variant = 'list',
  className,
}: {
  variant?: 'list' | 'cards' | 'table';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-7 w-48 rounded-full" />
        <Skeleton className="h-3.5 w-80 max-w-full rounded-full" />
      </div>
      {variant === 'cards' ? (
        <SkeletonCards />
      ) : variant === 'table' ? (
        <SkeletonList rows={6} avatar={false} />
      ) : (
        <SkeletonList rows={6} />
      )}
    </div>
  );
}
