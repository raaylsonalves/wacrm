/**
 * Modules an agency-managed client account can be sold (migration 091).
 * `accounts.modules` NULL means everything; otherwise only the listed
 * keys show up for the client's own users. Operators always see all.
 * Navigation packaging only — RLS is still the authorization layer.
 */
export const MODULES = [
  'inbox',
  'cases',
  'contacts',
  'pipelines',
  'prospecting',
  'agenda',
  'ai',
  'broadcasts',
  'channels',
  'settings',
] as const;

export type ModuleKey = (typeof MODULES)[number];

/** Ready-made packages for the portfolio's quick picks. */
export const MODULE_PRESETS: Record<string, ModuleKey[] | null> = {
  full: null,
  attendance: ['inbox', 'contacts', 'agenda'],
  automation: ['ai', 'channels'],
};

const PATH_MODULE: [string, ModuleKey][] = [
  ['/inbox', 'inbox'],
  ['/cases', 'cases'],
  ['/contacts', 'contacts'],
  ['/pipelines', 'pipelines'],
  ['/prospecting', 'prospecting'],
  ['/agenda', 'agenda'],
  ['/agents', 'ai'],
  ['/automations', 'ai'],
  ['/flows', 'ai'],
  ['/broadcasts', 'broadcasts'],
  ['/templates', 'broadcasts'],
];

/** Which module a dashboard path (or nav href) belongs to; null = always on. */
export function moduleForPath(href: string): ModuleKey | null {
  const [path, query = ''] = href.split('?');
  if (path === '/settings' || path.startsWith('/settings/')) {
    return query.includes('tab=whatsapp') ? 'channels' : 'settings';
  }
  for (const [prefix, key] of PATH_MODULE) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return key;
  }
  return null;
}

export function isPathAllowed(
  href: string,
  modules: readonly string[] | null | undefined,
  bypass: boolean
): boolean {
  if (bypass || !modules) return true;
  const key = moduleForPath(href);
  return key === null || modules.includes(key);
}
