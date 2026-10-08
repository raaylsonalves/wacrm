// Audience reads shared by the broadcast wizard's estimate (step 2) and
// the send itself (hooks/use-broadcast-sending). Both page through every
// row (lib/supabase/paginate): a plain select stops at 1000 rows without
// an error, so the estimate and the send used to disagree past that size
// and the send silently skipped the rest.

import type { createClient } from '@/lib/supabase/client';
import { fetchAllRows } from '@/lib/supabase/paginate';

type Client = ReturnType<typeof createClient>;

export interface AudienceFieldFilter {
  fieldId: string;
  operator: 'is' | 'is_not' | 'contains';
  value: string;
}

/** Contacts carrying any of the tags. */
export async function tagMemberIds(
  supabase: Client,
  tagIds: string[]
): Promise<Set<string>> {
  const rows = await fetchAllRows<{ contact_id: string }>((from, to) =>
    supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tagIds)
      .order('contact_id')
      .order('tag_id')
      .range(from, to)
  );
  return new Set(rows.map((r) => r.contact_id));
}

/** Contacts whose custom field matches the filter. */
export async function customFieldMatchIds(
  supabase: Client,
  filter: AudienceFieldFilter
): Promise<Set<string>> {
  const { fieldId, operator, value } = filter;
  const rows = await fetchAllRows<{ contact_id: string }>((from, to) => {
    let q = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);
    // ilike with wildcards: "contains" is case-insensitive.
    if (operator === 'is') q = q.eq('value', value);
    else if (operator === 'is_not') q = q.neq('value', value);
    else q = q.ilike('value', `%${value}%`);
    return q.order('id').range(from, to);
  });
  return new Set(rows.map((r) => r.contact_id));
}
