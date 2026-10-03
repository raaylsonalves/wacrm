"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell, ChevronDown } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { cn } from "@/lib/utils";

const pageTitles: Record<string, string> = {
  "/dashboard": "dashboard",
  "/agenda": "agenda",
  "/operator": "operator",
  "/inbox": "inbox",
  "/notifications": "notifications",
  "/contacts": "contacts",
  "/pipelines": "pipelines",
  "/broadcasts": "broadcasts",
  "/automations": "automations",
  "/settings": "settings",
};

// Pages whose title lives with the sidebar labels, not in Header.
const sidebarTitles: Record<string, string> = {
  "/agents": "aiAgents",
  "/flows": "flows",
  "/cases": "cases",
  "/prospecting": "prospecting",
};

// Pages that open with their own heading (v2): the greeting, the
// "Conversas" list card, or a page h1 with its description and actions.
// The shell header shows no title there — on desktop it disappears, on
// phones only the account pill + bell row stays.
const OWN_HEADING: RegExp[] = [
  /^\/dashboard$/,
  /^\/inbox(\/|$)/,
  /^\/agents$/,
  /^\/automations$/,
  /^\/automations\/[^/]+\/logs$/,
  /^\/broadcasts(\/[^/]+)?$/,
  /^\/cases$/,
  /^\/contacts$/,
  /^\/flows$/,
  /^\/flows\/[^/]+\/runs$/,
  /^\/notifications$/,
  /^\/operator$/,
  /^\/prospecting$/,
  /^\/settings$/,
];

function sidebarTitleKey(pathname: string): string | undefined {
  return Object.entries(sidebarTitles).find(([path]) => pathname.startsWith(path))?.[1];
}

function getPageTitleKey(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname];
  const match = Object.entries(pageTitles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : "dashboard";
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

interface HeaderProps {
  /** Opens the sidebar drawer on phones (the account pill). */
  onOpenSidebar?: () => void;
}

/**
 * v2 shell header. Phones (M2): the account pill (opens the menu drawer)
 * and the notifications bell, then the page title when the page has no
 * heading of its own. Desktop: just the 28px title — the account, theme
 * and push controls live in the sidebar. Hidden inside an open
 * conversation on phones, where the thread header takes the top.
 */
function HeaderInner({ onOpenSidebar }: HeaderProps) {
  const t = useTranslations("Header");
  const tSidebar = useTranslations("Sidebar");
  const pathname = usePathname();
  const params = useSearchParams();
  const { account } = useAuth();
  const unread = useUnreadNotifications();
  const titleKey = getPageTitleKey(pathname);
  const sidebarKey = sidebarTitleKey(pathname);
  const ownHeading = OWN_HEADING.some((re) => re.test(pathname));
  const inThread = pathname.startsWith("/inbox") && params.has("c");
  const accountName = account?.display_name || account?.name || tSidebar("title");

  return (
    <header
      className={cn(
        "shrink-0 px-4 pt-3 pb-1 lg:px-6 lg:pt-6 lg:pb-0",
        ownHeading && "lg:hidden",
        inThread && "max-lg:hidden",
      )}
    >
      <div className="flex items-center justify-between gap-3 lg:hidden">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={t("openMenu")}
          className="border-border bg-card hover:bg-muted flex min-h-11 min-w-0 items-center gap-2 rounded-full border py-1 pr-3 pl-1 transition-colors duration-150 ease-out"
        >
          {account?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- account-supplied URL
            <img src={account.logo_url} alt="" className="size-[34px] shrink-0 rounded-full object-contain" />
          ) : (
            <span className="bg-tone-salmon text-tone-on flex size-[34px] shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold">
              {initialsOf(accountName)}
            </span>
          )}
          <span className="text-foreground truncate text-[13px] font-semibold">{accountName}</span>
          <ChevronDown className="text-muted-foreground size-4 shrink-0" />
        </button>
        <Link
          href="/notifications"
          aria-label={tSidebar("notifications")}
          className="border-border bg-card text-foreground hover:bg-muted relative flex size-11 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ease-out"
        >
          <Bell className="size-[18px]" />
          {unread > 0 && (
            <span className="bg-tone-salmon text-tone-on absolute -top-1 -right-1 min-w-5 rounded-full px-1 text-center text-[10px] leading-5 font-bold tabular-nums">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Link>
      </div>
      {!ownHeading && (
        <h1 className="text-foreground mt-3 truncate text-[26px] leading-tight font-bold tracking-[-0.02em] lg:mt-0 lg:text-[28px]">
          {sidebarKey ? tSidebar(sidebarKey) : t(titleKey as string)}
        </h1>
      )}
    </header>
  );
}

export function Header(props: HeaderProps) {
  // useSearchParams needs a Suspense boundary under the App Router.
  return (
    <Suspense fallback={null}>
      <HeaderInner {...props} />
    </Suspense>
  );
}
