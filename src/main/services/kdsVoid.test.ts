/**
 * Run with: pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const kdsOrderFindFirst = vi.fn();
const kdsTicketFindMany = vi.fn();
const kdsTicketUpdate = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    $transaction: (fn: (tx: any) => Promise<unknown>) =>
      fn({
        kdsOrder: {
          findFirst: (...a: any[]) => kdsOrderFindFirst(...a),
        },
        kdsTicket: {
          findMany: (...a: any[]) => kdsTicketFindMany(...a),
          update: (...a: any[]) => kdsTicketUpdate(...a),
        },
      }),
  },
}));

vi.mock('./kdsSchema', () => ({
  ensureKdsLocalSchema: vi.fn().mockResolvedValue(true),
}));

import { applyKdsVoidItem } from './kdsVoid';

describe('applyKdsVoidItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kdsOrderFindFirst.mockResolvedValue({ id: 9 });
    kdsTicketUpdate.mockResolvedValue({});
  });

  it('marks the first matching non-voided KDS line as voided', async () => {
    kdsTicketFindMany.mockResolvedValue([
      {
        id: 42,
        itemsJson: [
          { name: 'Burger', qty: 1, station: 'KITCHEN' },
          { name: 'Burger', qty: 1, station: 'KITCHEN' },
        ],
      },
    ]);

    const ok = await applyKdsVoidItem({
      userId: 1,
      area: 'Main',
      tableLabel: 'T1',
      item: { name: 'Burger' },
    });

    expect(ok).toBe(true);
    expect(kdsTicketUpdate).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        itemsJson: [
          { name: 'Burger', qty: 1, station: 'KITCHEN', voided: true },
          { name: 'Burger', qty: 1, station: 'KITCHEN' },
        ],
      },
    });
  });
});
