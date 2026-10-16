/**
 * The live room (specs/painel-gestor.md phase 5): where each person
 * stands and what they are doing, from the same data as the hub.
 * Sprites live in public/hub (generated art, cut from a green sheet).
 */
export const ROOMS = ['gestao', 'atendimento', 'comemoracao', 'recepcao', 'negociacao'] as const;
export type RoomId = (typeof ROOMS)[number];
export type Pose = 'idle' | 'desk' | 'phone' | 'celebrate';

/** p0 has every pose; p1–p6 are look variants with only the idle pose. */
export const LOOKS = 7;

export interface RoomMemberInput {
  userId: string;
  name: string;
  role: string | null;
  presence: 'online' | 'away' | 'offline';
  waiting: number;
  late: boolean;
  /** Won a deal in the last few minutes. */
  justWon: boolean;
  /** Created or moved a deal in the last few minutes. */
  negotiating: boolean;
}

export interface Placed {
  userId: string;
  name: string;
  room: RoomId;
  pose: Pose;
  look: number;
  waiting: number;
  late: boolean;
  away: boolean;
}

/** Stable look per person (same person, same character every day). */
export function lookFor(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return h % LOOKS;
}

export function placeTeam(members: RoomMemberInput[]): Placed[] {
  return members
    .filter((m) => m.presence !== 'offline')
    .map((m) => {
      const base = { userId: m.userId, name: m.name, look: lookFor(m.userId), waiting: m.waiting, late: m.late, away: m.presence === 'away' };
      if (m.justWon) return { ...base, room: 'comemoracao' as const, pose: 'celebrate' as const };
      if (m.negotiating) return { ...base, room: 'negociacao' as const, pose: 'idle' as const };
      if (m.presence === 'away') return { ...base, room: 'recepcao' as const, pose: 'idle' as const };
      if (m.waiting > 0) return { ...base, room: 'atendimento' as const, pose: 'phone' as const };
      if (m.role === 'owner' || m.role === 'admin') return { ...base, room: 'gestao' as const, pose: 'desk' as const };
      return { ...base, room: 'atendimento' as const, pose: 'desk' as const };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Looks drawn with every pose (public/hub/char-p<n>-<pose>.webp).
 *  The others only have their idle sprite (char-p<n>.webp) until their
 *  pose sheet is generated; add the look here when it is. */
export const POSED_LOOKS = new Set([0, 1]);

/** Sprite file for a person. */
export function spriteFor(look: number, pose: Pose): string {
  if (POSED_LOOKS.has(look)) return `/hub/char-p${look}-${pose}.webp`;
  return `/hub/char-p${look}.webp`;
}

/** A made-up team for /hub?demo=1: shows every room and state. */
export const DEMO_TEAM: RoomMemberInput[] = [
  { userId: 'demo-0', name: 'Ana Souza', role: 'owner', presence: 'online', waiting: 0, late: false, justWon: false, negotiating: false },
  { userId: 'demo-1', name: 'Bruno Lima', role: 'agent', presence: 'online', waiting: 2, late: false, justWon: false, negotiating: false },
  { userId: 'demo-2', name: 'Carla Dias', role: 'agent', presence: 'online', waiting: 0, late: false, justWon: false, negotiating: false },
  { userId: 'demo-3', name: 'Diego Rocha', role: 'agent', presence: 'online', waiting: 3, late: true, justWon: false, negotiating: false },
  { userId: 'demo-4', name: 'Elisa Prado', role: 'agent', presence: 'online', waiting: 0, late: false, justWon: true, negotiating: false },
  { userId: 'demo-5', name: 'Fábio Nunes', role: 'agent', presence: 'online', waiting: 0, late: false, justWon: false, negotiating: true },
  { userId: 'demo-6', name: 'Gabi Torres', role: 'agent', presence: 'away', waiting: 0, late: false, justWon: false, negotiating: false },
  { userId: 'demo-7', name: 'Hugo Melo', role: 'agent', presence: 'online', waiting: 0, late: false, justWon: false, negotiating: false },
];
