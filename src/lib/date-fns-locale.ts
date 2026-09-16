import { enUS, es, ko, ptBR, type Locale } from "date-fns/locale";

/**
 * date-fns doesn't read `NEXT_PUBLIC_APP_LOCALE` on its own — every
 * `format()` / `formatDistanceToNow()` call defaults to en-US month
 * names, weekday names, and relative-time phrasing ("about 2 hours")
 * unless a `locale` option is passed explicitly. This is that option,
 * kept in one place so it stays in sync with `messages/*.json` and
 * `src/i18n/request.ts` (same env var, same locale set).
 */
const LOCALES: Record<string, Locale> = {
  en: enUS,
  pt: ptBR,
  es,
  ko,
};

export const dateFnsLocale: Locale =
  LOCALES[process.env.NEXT_PUBLIC_APP_LOCALE || "en"] ?? enUS;
