import { describe, expect, it } from 'vitest';
import { readTicketForTable, type TicketReadDeps } from './ticketRead';

function deps(
  answers: Array<unknown | Error>,
): TicketReadDeps & { calls: number; invalidated: number } {
  const state = {
    calls: 0,
    invalidated: 0,
    fetch: async () => {
      const answer = answers[Math.min(state.calls, answers.length - 1)];
      state.calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    invalidate: () => {
      state.invalidated += 1;
    },
  };
  return state;
}

describe('readTicketForTable', () => {
  it('returns the lines the host reports', async () => {
    const d = deps([{ items: [{ name: 'Byrek', qty: 1 }], note: 'no salt' }]);
    const read = await readTicketForTable('Salla', 'T7', d);

    expect(read).toEqual({
      ok: true,
      items: [{ name: 'Byrek', qty: 1 }],
      note: 'no salt',
    });
    expect(d.calls).toBe(1);
    expect(d.invalidated).toBe(0);
  });

  it('re-reads past the cache before believing a bill is empty', async () => {
    // First answer is a cached leftover (e.g. a floor snapshot row with no
    // lines); the host still holds the sitting's four items.
    const d = deps([
      { items: [] },
      { items: [{ name: 'Tave kosi', qty: 4 }], note: '' },
    ]);
    const read = await readTicketForTable('Salla', 'T7', d);

    expect(d.invalidated).toBe(1);
    expect(read).toEqual({
      ok: true,
      items: [{ name: 'Tave kosi', qty: 4 }],
      note: '',
    });
  });

  it('reports a genuinely empty bill as empty', async () => {
    const d = deps([{ items: [] }, { items: [] }]);
    const read = await readTicketForTable('Salla', 'T7', d);

    expect(read).toEqual({ ok: true, items: [], note: '' });
    expect(d.calls).toBe(2);
  });

  it('reports an unreadable bill instead of an empty one', async () => {
    const d = deps([new Error('unauthenticated')]);

    await expect(readTicketForTable('Salla', 'T7', d)).resolves.toEqual({
      ok: false,
    });
  });

  it('reports unreadable when the confirming read fails', async () => {
    const d = deps([{ items: [] }, new Error('EHOSTDOWN')]);

    await expect(readTicketForTable('Salla', 'T7', d)).resolves.toEqual({
      ok: false,
    });
  });

  it('treats a missing ticket as an empty bill, not a failure', async () => {
    const d = deps([null, null]);

    await expect(readTicketForTable('Salla', 'T7', d)).resolves.toEqual({
      ok: true,
      items: [],
      note: '',
    });
  });
});
