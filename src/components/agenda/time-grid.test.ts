import { describe, expect, it } from 'vitest';
import { HOUR_PX, gridRange, minuteAt, placeItems } from './time-grid';

const h = (hh: number, mm = 0) => hh * 60 + mm;

describe('gridRange', () => {
  it('spans the business day', () => {
    expect(gridRange(h(9), h(19), [])).toEqual({ from: h(9), to: h(19) });
  });

  it('grows to whole hours around appointments outside business hours', () => {
    expect(
      gridRange(h(9), h(18), [
        { id: 'a', startMin: h(7, 30), endMin: h(8) },
        { id: 'b', startMin: h(18), endMin: h(18, 45) },
      ])
    ).toEqual({
      from: h(7),
      to: h(19),
    });
  });
});

describe('placeItems', () => {
  it('positions by start and duration', () => {
    const [p] = placeItems(
      [{ id: 'a', startMin: h(10, 30), endMin: h(11, 30) }],
      h(9)
    );
    expect(p.top).toBe(1.5 * HOUR_PX);
    expect(p.height).toBe(HOUR_PX - 4);
    expect([p.lane, p.lanes]).toEqual([0, 1]);
  });

  it('keeps a minimum height for very short items', () => {
    const [p] = placeItems(
      [{ id: 'a', startMin: h(10), endMin: h(10, 5) }],
      h(9)
    );
    expect(p.height).toBe(24);
  });

  it('puts overlapping items side by side and leaves the rest full width', () => {
    const placed = placeItems(
      [
        { id: 'a', startMin: h(10), endMin: h(11) },
        { id: 'b', startMin: h(10, 30), endMin: h(11, 30) },
        { id: 'c', startMin: h(14), endMin: h(15) },
      ],
      h(9)
    );
    const by = Object.fromEntries(placed.map((p) => [p.id, p]));
    expect([by.a.lane, by.a.lanes]).toEqual([0, 2]);
    expect([by.b.lane, by.b.lanes]).toEqual([1, 2]);
    expect([by.c.lane, by.c.lanes]).toEqual([0, 1]);
  });

  it('reuses a lane once its item has ended', () => {
    const placed = placeItems(
      [
        { id: 'a', startMin: h(10), endMin: h(12) },
        { id: 'b', startMin: h(10), endMin: h(10, 30) },
        { id: 'c', startMin: h(10, 30), endMin: h(11) },
      ],
      h(9)
    );
    const by = Object.fromEntries(placed.map((p) => [p.id, p]));
    expect(by.c.lane).toBe(by.b.lane);
    expect(by.a.lanes).toBe(2);
  });
});

describe('minuteAt', () => {
  it('snaps a click to the slot step', () => {
    expect(minuteAt(1.6 * HOUR_PX, h(9), 30)).toBe(h(10, 30));
    expect(minuteAt(-5, h(9), 30)).toBe(h(9));
  });
});
