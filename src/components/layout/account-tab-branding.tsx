'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import {
  buildTabTitle,
  faviconHrefForAccount,
  sectionKeyForPath,
} from '@/lib/branding/tab';

const ORIGINAL_HREF = 'accountBrandingOriginalHref';

/**
 * Headless — renders nothing. Brands the browser tab with the current
 * account (Settings → Branding): title "Section — Display name", and the
 * account logo (or the default mark in the brand color) as favicon.
 *
 * Only after login, by design: the login page, the installed PWA's
 * name/icon (fixed by the OS at install time) and push titles keep the
 * deploy-level brand.
 *
 * Next's metadata owns <title> and the icon <link>s and may rewrite them
 * on navigation, so a MutationObserver re-applies ours whenever they
 * drift. Each write is guarded by an equality check, so our own writes
 * don't re-trigger it into a loop.
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
  const faviconHref = faviconHrefForAccount(account);

  useEffect(() => {
    const originalTitle = document.title;

    const apply = () => {
      if (document.title !== title) document.title = title;
      if (!faviconHref) return;
      document
        .querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')
        .forEach((link) => {
          if (link.dataset[ORIGINAL_HREF] === undefined) {
            link.dataset[ORIGINAL_HREF] = link.getAttribute('href') ?? '';
          }
          if (link.getAttribute('href') !== faviconHref) {
            link.setAttribute('href', faviconHref);
            // Next's icon links may declare a PNG type/size; ours can be
            // an SVG data URL or any logo format.
            link.removeAttribute('type');
            link.removeAttribute('sizes');
          }
        });
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    return () => {
      observer.disconnect();
      document.title = originalTitle;
      document
        .querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')
        .forEach((link) => {
          const original = link.dataset[ORIGINAL_HREF];
          if (original !== undefined) {
            link.setAttribute('href', original);
            delete link.dataset[ORIGINAL_HREF];
          }
        });
    };
  }, [title, faviconHref]);

  return null;
}
