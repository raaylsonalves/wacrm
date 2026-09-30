/**
 * Which calendar connection a booking belongs to. Kept free of Node
 * imports: `appointments/store.ts` is also bundled into the agenda page.
 */

export interface ConnectionRef {
  id: string;
  user_id: string | null;
  status: string;
}

/** The assignee's own calendar if connected, else the shared one. */
export function connectionFor<T extends ConnectionRef>(
  connections: T[],
  assignedTo: string | null
): T | null {
  const active = connections.filter((c) => c.status === 'active');
  if (assignedTo) {
    const own = active.find((c) => c.user_id === assignedTo);
    if (own) return own;
  }
  return active.find((c) => c.user_id === null) ?? null;
}
