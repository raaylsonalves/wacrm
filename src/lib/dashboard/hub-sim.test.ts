import { describe, expect, it } from 'vitest';
import { LOOP, SIM_SCRIPT, simAt } from './hub-sim';

describe('hub simulation', () => {
  it('starts quiet and fills the room as the script runs', () => {
    expect(simAt(0).visitors).toEqual([]);
    const s = simAt(3);
    expect(s.visitors).toMatchObject([{ name: 'Marina', room: 'recepcao' }]);
    expect(s.queue).toBe(1);
    expect(s.log[0]).toMatchObject({ kind: 'enter', name: 'Marina' });
  });

  it('hands customers to people and moves deals to the negotiation room', () => {
    const s = simAt(25);
    const bruno = s.team.find((m) => m.userId === 'sim-bruno')!;
    expect(bruno.waiting).toBe(0);
    expect(s.visitors.find((v) => v.name === 'Marina')?.room).toBe(
      'atendimento'
    );
    expect(s.visitors.find((v) => v.name === 'Paulo')?.room).toBe('negociacao');
    expect(s.team.find((m) => m.userId === 'sim-carla')?.negotiating).toBe(
      true
    );
  });

  it('a win sends the agent to celebrate; leavers walk out, then go away', () => {
    const s = simAt(51);
    expect(s.team.find((m) => m.userId === 'sim-carla')).toMatchObject({
      justWon: true,
      negotiating: false,
    });
    expect(simAt(55).visitors.find((v) => v.name === 'Paulo')?.room).toBe(
      'out'
    );
    expect(simAt(62).visitors.find((v) => v.name === 'Paulo')).toBeUndefined();
  });

  it('loops cleanly and keeps the last loop in the log', () => {
    expect(
      SIM_SCRIPT.every((e, i) => i === 0 || e.at >= SIM_SCRIPT[i - 1].at)
    ).toBe(true);
    expect(SIM_SCRIPT.at(-1)!.at + 7).toBeLessThanOrEqual(LOOP);
    const s = simAt(LOOP + 0.5);
    expect(s.visitors).toEqual([]);
    expect(s.log.length).toBe(8);
    expect(s.log[0].at).toBeLessThan(LOOP);
  });
});
