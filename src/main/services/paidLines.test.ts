import { describe, expect, it, vi } from 'vitest';

vi.mock('./tableSession', () => ({
  findLatestTicketLogForCurrentSession: async () => null,
  getCurrentTableSessionKey: async () => null,
}));
vi.mock('./ticketLogWrite', () => ({
  writeTicketSnapshot: async () => 'written',
}));

import { markPaidLines } from './paidLines';
describe('markPaidLines', () => {
  it('marks a whole line paid when all of it is paid', () => {
    const out = markPaidLines(
      [{ lineId: 'a', sku: 'BEER', name: 'Beer', qty: 3 } as any],
      [{ lineId: 'a', sku: 'BEER', name: 'Beer', qty: 3 } as any],
    );
    expect(out).toEqual([
      { lineId: 'a', sku: 'BEER', name: 'Beer', qty: 3, paid: true },
    ]);
  });

  it('marks only the part paid when a line is paid in part', () => {
    const out = markPaidLines(
      [{ lineId: 'a', sku: 'BEER', name: 'Beer', qty: 3, unitPrice: 3 } as any],
      [{ lineId: 'a', sku: 'BEER', name: 'Beer', qty: 1, unitPrice: 3 } as any],
    );
    expect(out).toHaveLength(2);
    expect(out!.find((l) => l.paid)?.qty).toBe(1);
    const rest = out!.find((l) => !l.paid)!;
    expect(rest.qty).toBe(2);
    expect(rest.lineId).toBe('a');
  });
});
