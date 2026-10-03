'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { BottomNav } from '@/components/layout/bottom-nav';
import { OperatorBanner } from '@/components/operator/operator-banner';
import { ModuleGuard } from '@/components/layout/module-guard';
import { AccountAccessAlert } from '@/components/layout/account-access-alert';
import { BrandColorEffect } from '@/components/layout/brand-color-effect';
import { AccountTabBranding } from '@/components/layout/account-tab-branding';
import { PresenceHeartbeat } from '@/components/presence/presence-heartbeat';
import { BrowserNotificationsListener } from '@/components/notifications/browser-notifications-listener';
import { SplashScreen } from '@/components/layout/splash-screen';
import { RouteProgress } from '@/components/layout/route-progress';

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  // The opening mural covers the screen while the session resolves and
  // fades out on top of the app once it can render. It keeps the same
  // tree position in both branches so it isn't remounted (and replayed)
  // when loading flips.
  return (
    <>
      <SplashScreen ready={!loading} />
      {loading || !user ? null : (
        <div className="bg-background flex h-screen overflow-hidden lg:gap-3 lg:p-3">
          {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
          <PresenceHeartbeat />
          {/* Desktop alerts for new customer messages (opt-in via Settings →
          Your profile). Headless — renders nothing. */}
          <BrowserNotificationsListener />
          {/* Applies the account's brand color, if set (Settings → Branding).
          Headless — renders nothing. */}
          <BrandColorEffect />
          {/* Tab title + favicon from the account's branding. Headless. */}
          <AccountTabBranding />
          <Sidebar open={sidebarOpen} onClose={closeSidebar} />
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <RouteProgress />
            {/* Operators only: "Operando: <client>" + the stale-tab guard. */}
            <OperatorBanner />
            <Header onOpenSidebar={() => setSidebarOpen(true)} />
            {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
            <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
              {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
              <AccountAccessAlert />
              {/* Pages a client account did not buy never mount (migration 091). */}
              <ModuleGuard>{children}</ModuleGuard>
            </main>
            {/* Phone tab bar — below lg only; "More" opens the sidebar drawer. */}
            <BottomNav onMore={() => setSidebarOpen(true)} />
          </div>
        </div>
      )}
    </>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
