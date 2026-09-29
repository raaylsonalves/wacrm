'use client';

import { useEffect, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import {
  buildTabTitle,
  faviconHrefForAccount,
  sectionKeyForPath,
} from '@/lib/branding/tab';
import { brandingQuery, brandingVersion } from '@/lib/pwa';

const ORIGINAL = 'accountBrandingOriginal';

interface HeadOverride {
  selector: string;
  attr: 'href' | 'content';
  value: string;
  /** Attributes to drop when overriding (e.g. a PNG `type` on an SVG). */
  strip?: string[];
}

/**
 * Headless — renders nothing. Applies the current account's branding
 * (Settings → Branding) to the page head after login:
 *
 *  - tab title "Section — Display name" and the favicon;
 *  - <link rel="manifest"> → /api/pwa/manifest?a=<account>, so the
 *    browser's "Install app" uses the account's name and logo;
 *  - apple-touch-icon + apple-mobile-web-app-title, which iOS reads
 *    from the page at "Add to Home Screen" time.
 *
 * Installing from the login page still gets the deploy-level brand —
 * there's no account there yet. And an app installed before this keeps
 * its old icon until reinstalled (iOS never refreshes it).
 *
 * Next's metadata owns these head tags and may rewrite them on
 * navigation, so a MutationObserver re-applies ours whenever they
 * drift. Every write is equality-guarded, so ours don't loop.
 */
export function AccountTabBranding() {
  const { account } = useAuth();
  const pathname = usePathname();
  const t = useTranslations('Sidebar');

  const sectionKey = sectionKeyForPath(pathname ?? '');
  const title = buildTabTitle(
    sectionKey ? t(sectionKey) : null,
    account?.display_name
  );

  const overrides = useMemo<HeadOverride[]>(() => {
    if (!account) return [];
    const list: HeadOverride[] = [];

    const favicon = faviconHrefForAccount(account);
    if (favicon) {
      list.push({
        selector: 'link[rel~="icon"]',
        attr: 'href',
        value: favicon,
        strip: ['type', 'sizes'],
      });
    }

    const q = brandingQuery({
      accountId: account.id,
      version: brandingVersion([
        account.display_name,
        account.logo_url,
        account.brand_color,
      ]),
    });
    if (q) {
      list.push(
        {
          selector: 'link[rel="manifest"]',
          attr: 'href',
          value: `/api/pwa/manifest${q}`,
        },
        {
          selector: 'link[rel="apple-touch-icon"]',
          attr: 'href',
          value: `/pwa-icon/apple${q}`,
        }
      );
    }

    const appName = account.display_name?.trim();
    if (appName) {
      list.push({
        selector: 'meta[name="apple-mobile-web-app-title"]',
        attr: 'content',
        value: appName,
      });
    }
    return list;
  }, [account]);

  useEffect(() => {
    const originalTitle = document.title;

    const apply = () => {
      if (document.title !== title) document.title = title;
      for (const o of overrides) {
        const key = `${ORIGINAL}${o.attr === 'href' ? 'Href' : 'Content'}`;
        document.querySelectorAll<HTMLElement>(o.selector).forEach((el) => {
          if (el.dataset[key] === undefined) {
            el.dataset[key] = el.getAttribute(o.attr) ?? '';
          }
          if (el.getAttribute(o.attr) !== o.value) {
            el.setAttribute(o.attr, o.value);
            o.strip?.forEach((a) => el.removeAttribute(a));
          }
        });
      }
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'content'],
    });

    return () => {
      observer.disconnect();
      document.title = originalTitle;
      for (const o of overrides) {
        const key = `${ORIGINAL}${o.attr === 'href' ? 'Href' : 'Content'}`;
        document.querySelectorAll<HTMLElement>(o.selector).forEach((el) => {
          const original = el.dataset[key];
          if (original !== undefined) {
            el.setAttribute(o.attr, original);
            delete el.dataset[key];
          }
        });
      }
    };
  }, [title, overrides]);

  return null;
}
