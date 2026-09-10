/**
 * Run with: pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const kdsOrderFindFirst = vi.fn();
const kdsOrderUpdate = vi.fn();
const kdsTicketFindMany = vi.fn();
const kdsTicketUpdate = vi.fn();
const kdsTicketStationUpdateMany = vi.fn();
const userFindUnique = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    $transaction: (fn: (tx: any) => Promise<unknown>) =>
      fn({
        kdsOrder: {
          findFirst: (...a: any[]) => kdsOrderFindFirst(...a),
          update: (...a: any[]) => kdsOrderUpdate(...a),
        },
        kdsTicket: {
          findMany: (...a: any[]) => kdsTicketFindMany(...a),
          update: (...a: any[]) => kdsTicketUpdate(...a),
        },
        kdsTicketStation: {
          updateMany: (...a: any[]) => kdsTicketStationUpdateMany(...a),
        },
        user: {
          findUnique: (...a: any[]) => userFindUnique(...a),
        },
      }),
  },
}));

vi.mock('./kdsSchema', () => ({
  ensureKdsLocalSchema: vi.fn().mockResolvedValue(true),
}));

import { applyKdsVoidItem, applyKdsVoidTicket } from './kdsVoid';

describe('applyKdsVoidItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kdsOrderFindFirst.mockResolvedValue({ id: 9 });
    kdsTicketUpdate.mockResolvedValue({});
    kdsTicketStationUpdateMany.mockResolvedValue({ count: 1 });
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
    expect(kdsTicketStationUpdateMany).not.toHaveBeenCalled();
  });

  it('bumps the station off NEW when the last live line is voided', async () => {
    kdsTicketFindMany.mockResolvedValue([
      {
        id: 42,
        itemsJson: [{ name: 'Burger', qty: 1, station: 'KITCHEN' }],
      },
    ]);

    const ok = await applyKdsVoidItem({
      userId: 1,
      area: 'Main',
      tableLabel: 'T1',
      item: { name: 'Burger' },
    });

    expect(ok).toBe(true);
    expect(kdsTicketStationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ticketId: 42, status: 'NEW' },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    );
  });
});

describe('applyKdsVoidTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUnique.mockResolvedValue({ id: 1 });
    kdsTicketUpdate.mockResolvedValue({});
    kdsTicketStationUpdateMany.mockResolvedValue({ count: 1 });
    kdsOrderUpdate.mockResolvedValue({});
  });

  it('voids every line and bumps NEW stations even if the order was already closed', async () => {
    kdsOrderFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 9,
        closedAt: new Date('2026-09-05T16:00:00Z'),
      });
    kdsTicketFindMany.mockResolvedValue([
      {
        id: 42,
        note: null,
        itemsJson: [
          { name: 'Steak', qty: 1, station: 'KITCHEN' },
          { name: 'Fries', qty: 1, station: 'KITCHEN' },
        ],
      },
    ]);

    const ok = await applyKdsVoidTicket({
      userId: 1,
      area: 'Salla',
      tableLabel: 'T7',
      reason: 'Guest left',
    });

    expect(ok).toBe(true);
    expect(kdsTicketUpdate).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        itemsJson: [
          { name: 'Steak', qty: 1, station: 'KITCHEN', voided: true },
          { name: 'Fries', qty: 1, station: 'KITCHEN', voided: true },
        ],
        note: 'VOIDED: Guest left',
      },
    });
    expect(kdsTicketStationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ticketId: 42, status: 'NEW' },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    );
    expect(kdsOrderUpdate).not.toHaveBeenCalled();
  });

  it('closes an still-open KDS order after voiding its tickets', async () => {
    kdsOrderFindFirst.mockResolvedValue({ id: 9, closedAt: null });
    kdsTicketFindMany.mockResolvedValue([
      {
        id: 42,
        note: 'Course 1',
        itemsJson: [{ name: 'Steak', qty: 1, station: 'KITCHEN' }],
      },
    ]);

    const ok = await applyKdsVoidTicket({
      userId: 1,
      area: 'Salla',
      tableLabel: 'T7',
    });

    expect(ok).toBe(true);
    expect(kdsOrderUpdate).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { closedAt: expect.any(Date) },
    });
  });
});
