"use client"

import { Suspense } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { PriorityPanel, TodayGreeting, useTodayData } from '@/components/dashboard/today-focus'
import { ManagerOverview } from '@/components/dashboard/manager-overview'
import { ManagerTeam } from '@/components/dashboard/manager-team'
import { ServiceReport } from '@/components/analytics/service-report'
import { useCan } from '@/hooks/use-can'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { Tv } from 'lucide-react'

// Painel in tabs (specs/painel-gestor.md). Each tab answers one question:
//   overview — what is happening now (owner / admins)
//   team     — what each person did (owner / admins)
//   service  — how the business is doing: the service report
//   queue    — what is mine to do (everyone; an agent's only tab)
// The old metric cards and charts gave a manager numbers with no action
// attached and no way to follow the team; they are gone from here.
const MANAGER_TABS = ['overview', 'team', 'service', 'queue'] as const
type Tab = (typeof MANAGER_TABS)[number]

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  )
}

function Dashboard() {
  const t = useTranslations('Manager')
  const tHub = useTranslations('Hub')
  const today = useTodayData()
  const canViewTeam = useCan('view-team')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const tabs: readonly Tab[] = canViewTeam ? MANAGER_TABS : ['queue']
  const asked = params.get('tab') as Tab | null
  const tab: Tab = asked && tabs.includes(asked) ? asked : tabs[0]

  const select = (next: Tab) => {
    const q = new URLSearchParams(params.toString())
    q.set('tab', next)
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-5">
      <TodayGreeting data={today} />

      {tabs.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={t('tabsLabel')} className="border-border bg-card flex flex-wrap gap-1 self-start rounded-full border p-1">
          {tabs.map((key) => {
            const count = key === 'queue' ? today.priority.length : 0
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => select(key)}
                className={cn(
                  'flex min-h-10 items-center gap-2 rounded-full px-4 text-[13.5px] font-semibold transition-colors duration-150 ease-out',
                  tab === key ? 'bg-foreground text-background' : 'text-foreground hover:bg-muted'
                )}
              >
                {t(`tabs.${key}`)}
                {count > 0 && (
                  <span className="bg-tone-salmon text-tone-on rounded-full px-1.5 text-[11px] leading-5 font-bold tabular-nums">
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <Link
          href="/hub"
          target="_blank"
          className="border-border hover:bg-muted inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-[13.5px] font-semibold"
        >
          <Tv className="size-4" /> {tHub('open')}
        </Link>
        </div>
      )}

      {tab === 'overview' && <ManagerOverview />}
      {tab === 'team' && <ManagerTeam />}
      {tab === 'service' && <ServiceReport />}
      {tab === 'queue' && <PriorityPanel data={today} />}
    </div>
  )
}
