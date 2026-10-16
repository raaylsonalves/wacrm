/**
 * Live hub for a TV (specs/painel-gestor.md phase 5): the day's ranking
 * and the "acontecendo agora" feed. Pure so they can be tested.
 */
export interface RankInput {
  user_id: string;
  name: string;
  won_value: number;
  deals_won: number;
  appointments: number;
  replies: number;
}

/** Sold value first, then deals, appointments and replies; idle people out. */
export function rankTeam(rows: RankInput[], limit = 5): RankInput[] {
  return rows
    .filter(
      (r) =>
        r.won_value > 0 ||
        r.deals_won > 0 ||
        r.appointments > 0 ||
        r.replies > 0
    )
    .sort(
      (a, b) =>
        b.won_value - a.won_value ||
        b.deals_won - a.deals_won ||
        b.appointments - a.appointments ||
        b.replies - a.replies ||
        a.name.localeCompare(b.name)
    )
    .slice(0, limit);
}

export interface FeedItem {
  at: string;
  kind: 'won' | 'appointment' | 'lead';
  who: string | null;
  title: string;
  amount?: number;
}

/** Newest first, capped. */
export function buildFeed(items: FeedItem[], limit = 8): FeedItem[] {
  return [...items]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}
