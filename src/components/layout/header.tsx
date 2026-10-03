"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { LogOut, Menu, Settings as SettingsIcon, User } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { PushStatusButton } from "@/components/notifications/push-status-button";

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

interface HeaderProps {
  /** Wired to the shell's drawer state. Used only on mobile — the
   *  hamburger button is hidden on lg+. */
  onOpenSidebar?: () => void;
}

import { useTranslations } from "next-intl";

export function Header({ onOpenSidebar }: HeaderProps) {
  const t = useTranslations("Header");
  const tSidebar = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, signOut } = useAuth();
  const titleKey = getPageTitleKey(pathname);
  const sidebarKey = sidebarTitleKey(pathname);

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 px-4 lg:h-14 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only. 44×44 hit target per Apple HIG. */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={t("openMenu")}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors duration-150 ease-out hover:bg-muted lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-lg font-bold tracking-tight text-foreground sm:text-xl">
          {sidebarKey ? tSidebar(sidebarKey) : t(titleKey as string)}
        </h1>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        <PushStatusButton />
        <ModeToggle />

        <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-full border border-transparent p-0.5 transition-colors duration-150 ease-out hover:border-border hover:bg-card focus-visible:border-border focus-visible:bg-card focus:outline-none data-popup-open:border-border data-popup-open:bg-card sm:gap-2.5 sm:pr-3.5"
          aria-label={t("openAccountMenu")}
        >
          <Avatar className="size-8">
            {profile?.avatar_url ? (
              <AvatarImage
                src={profile.avatar_url}
                alt={profile.full_name ?? t("defaultAvatar")}
              />
            ) : null}
            <AvatarFallback className="bg-tone-blue text-sm font-semibold text-tone-on">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm font-medium text-foreground sm:inline">
            {profile?.full_name ?? t("defaultUser")}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">
              {profile?.full_name ?? t("defaultUser")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {profile?.email ?? ""}
            </p>
          </div>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=profile"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <User className="size-4" />
            {t("menuProfile")}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=whatsapp"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <SettingsIcon className="size-4" />
            {t("menuSettings")}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={signOut}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <LogOut className="size-4" />
            {t("menuSignOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
