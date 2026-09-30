/** Pure pieces of the dashboard's "what now" block: greeting and name. */

export type Greeting = 'morning' | 'afternoon' | 'evening';

export function greetingFor(hour: number): Greeting {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** First word of a full name, for the greeting. */
export function firstName(full: string | null | undefined): string {
  return (full ?? '').trim().split(/\s+/)[0] ?? '';
}
