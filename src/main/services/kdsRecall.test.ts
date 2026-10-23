import { describe, expect, it, vi } from 'vitest';

vi.mock('./kdsRetention', () => ({ localDayStart: () => new Date(0) }));

import { recallKdsTicket } from './kdsRecall';

function fakePrisma(rows: any[]) {
  const ticketUpdate = vi.fn((a: any) => a);
  const stationUpdateMany = vi.fn((a: any) => a);
  const prisma: any = {
    kdsTicketStation: {
      findMany: vi.fn(async () => rows),
      updateMany: stationUpdateMany,
    },
    kdsTicket: { update: ticketUpdate },
    $transaction: vi.fn(async (ops: any[]) => ops),
  };
  return { prisma, ticketUpdate };
}

describe('recallKdsTicket — last bumped', () => {
  it('skips a card that was closed by a void', async () => {
    const { prisma, ticketUpdate } = fakePrisma([
      {
        ticketId: 9,
        ticket: {
          id: 9,
          itemsJson: [{ name: 'Steak', station: 'KITCHEN', voided: true }],
        },
      },
      {
        ticketId: 8,
        ticket: {
          id: 8,
          itemsJson: [{ name: 'Soup', station: 'KITCHEN', bumped: true }],
        },
      },
    ]);

    const r = await recallKdsTicket(prisma, { station: 'KITCHEN' });

    expect(r).toEqual({ ok: true, ticketId: 8 });
    expect(ticketUpdate).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { itemsJson: [{ name: 'Soup', station: 'KITCHEN' }] },
    });
  });

  it('recalls nothing when every recent card was voided', async () => {
    const { prisma } = fakePrisma([
      {
        ticketId: 9,
        ticket: {
          id: 9,
          itemsJson: [{ name: 'Steak', station: 'KITCHEN', voided: true }],
        },
      },
    ]);
    const r = await recallKdsTicket(prisma, { station: 'KITCHEN' });
    expect(r).toEqual({ ok: false, ticketId: null });
  });
});
