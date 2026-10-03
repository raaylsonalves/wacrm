"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tint: 'bg-tone-lilac-soft text-tone-lilac-ink' },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase, tint: 'bg-tone-blue-soft text-tone-blue-ink' },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio, tint: 'bg-tone-salmon-soft text-tone-salmon-ink' },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap, tint: 'bg-tone-mint-soft text-tone-mint-ink' },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')
  
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex min-h-14 items-center gap-3 rounded-[18px] border border-border bg-card px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-card-2"
          >
            <div className={`flex size-9 shrink-0 items-center justify-center rounded-full ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-[13px] leading-tight font-semibold text-foreground">{t(a.labelKey as string)}</span>
          </Link>
        )
      })}
    </div>
  )
}
