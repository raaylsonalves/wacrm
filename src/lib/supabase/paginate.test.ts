import { describe, expect, it } from 'vitest';
import { chunk, fetchAllRows } from './paginate';

function fakeTable(total: number) {
  const rows = Array.from({ length: total }, (_, i) => i);
  const calls: [number, number][] = [];
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  };
  return { page, calls };
}

describe('fetchAllRows', () => {
  it('reads past the per-request cap', async () => {
    const t = fakeTable(2500);
    const rows = await fetchAllRows(t.page, 1000);
    expect(rows).toHaveLength(2500);
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('asks one extra page when the total is an exact multiple', async () => {
    const t = fakeTable(2000);
    expect(await fetchAllRows(t.page, 1000)).toHaveLength(2000);
    expect(t.calls).toHaveLength(3);
  });

  it('handles an empty result', async () => {
    expect(await fetchAllRows(fakeTable(0).page)).toEqual([]);
  });

  it('throws on a query error', async () => {
    await expect(
      fetchAllRows(async () => ({ data: null, error: { message: 'boom' } }))
    ).rejects.toThrow('boom');
  });
});

describe('chunk', () => {
  it('splits into fixed-size slices', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
