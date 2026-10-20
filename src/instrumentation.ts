// Runs once per server instance (Next.js instrumentation hook).

/**
 * web-push (Web Push notifications, lib/push/send.ts) still calls the
 * legacy `url.parse()` — even in its latest release (3.6.7) — so Node logs
 * DEP0169 on every push and buries real errors in the log. It only parses
 * the push service's endpoint URL, which comes from the browser's own
 * subscription. Drop that one warning; every other warning still prints.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const code =
      (typeof rest[0] === 'object' && rest[0] !== null
        ? (rest[0] as { code?: string }).code
        : rest[1]) ?? (warning as { code?: string }).code;
    if (code === 'DEP0169') return;
    return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
