/**
 * Run with: pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const userFindUnique = vi.fn();
const kdsOrderFindFirst = vi.fn();
const kdsDayCounterUpsert = vi.fn();
const kdsDayCounterUpdate = vi.fn();
const kdsOrderCreate = vi.fn();
const kdsTicketFindFirst = vi.fn();
const kdsTicketUpdate = vi.fn();
const kdsTicketCreate = vi.fn();
const kdsTicketStationFindFirst = vi.fn();
const kdsTicketStationCreate = vi.fn();
const readSettings = vi.fn();
const loadKdsRoutingFromDb = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    $transaction: (fn: (tx: any) => Promise<unknown>) =>
      fn({
        user: { findUnique: (...a: any[]) => userFindUnique(...a) },
        kdsOrder: {
          findFirst: (...a: any[]) => kdsOrderFindFirst(...a),
          create: (...a: any[]) => kdsOrderCreate(...a),
        },
        kdsDayCounter: {
          upsert: (...a: any[]) => kdsDayCounterUpsert(...a),
          update: (...a: any[]) => kdsDayCounterUpdate(...a),
        },
        kdsTicket: {
          findFirst: (...a: any[]) => kdsTicketFindFirst(...a),
          update: (...a: any[]) => kdsTicketUpdate(...a),
          create: (...a: any[]) => kdsTicketCreate(...a),
        },
        kdsTicketStation: {
          findFirst: (...a: any[]) => kdsTicketStationFindFirst(...a),
          create: (...a: any[]) => kdsTicketStationCreate(...a),
        },
      }),
    category: { findMany: vi.fn().mockResolvedValue([]) },
    menuItem: { findMany: vi.fn().mockResolvedValue([]) },
    kdsDayCounter: { count: vi.fn().mockResolvedValue(0) },
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./core', () => ({
  coreServices: {
    readSettings: (...a: any[]) => readSettings(...a),
  },
}));

vi.mock('./kdsSchema', () => ({
  ensureKdsLocalSchema: vi.fn().mockResolvedValue(true),
}));

vi.mock('./kdsStationRouting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kdsStationRouting')>();
  return {
    ...actual,
    loadKdsRoutingFromDb: (...a: any[]) => loadKdsRoutingFromDb(...a),
    decorateKdsTicketItemsFromCategory: (lines: any[]) =>
      lines.map((l) => ({ ...l, station: 'KITCHEN' })),
  };
});

import { createKdsTicketFromLog } from './kdsCreateTicket';

describe('createKdsTicketFromLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUnique.mockResolvedValue({ id: 1 });
    readSettings.mockResolvedValue({ kds: { stations: { KITCHEN: true } } });
    loadKdsRoutingFromDb.mockResolvedValue({
      categoryIdToKdsStation: {},
      skuToKdsStation: {},
    });
    kdsOrderFindFirst.mockResolvedValue({ id: 10, orderNo: 5 });
    kdsTicketStationFindFirst.mockResolvedValue(null);
  });

  it('merges fireItems into an existing NEW ticket instead of creating another', async () => {
    kdsTicketFindFirst.mockResolvedValue({
      id: 99,
      itemsJson: [{ name: 'Soup', qty: 1, station: 'KITCHEN' }],
    });

    const result = await createKdsTicketFromLog({
      userId: 1,
      area: 'Sallon',
      tableLabel: 'T1',
      items: [
        { name: 'Soup', qty: 1, categoryId: 1 },
        { name: 'Steak', qty: 1, categoryId: 1 },
      ],
      fireItems: [{ name: 'Steak', qty: 1, categoryId: 1 }],
      note: null,
    });

    expect(result).toEqual({ orderNo: 5, ticketId: 99 });
    expect(kdsTicketCreate).not.toHaveBeenCalled();
    expect(kdsTicketUpdate).toHaveBeenCalledWith({
      where: { id: 99 },
      data: {
        itemsJson: [
          { name: 'Soup', qty: 1, station: 'KITCHEN' },
          { name: 'Steak', qty: 1, categoryId: 1, station: 'KITCHEN' },
        ],
      },
    });
  });

  it('creates a ticket when none is NEW on the open order', async () => {
    kdsTicketFindFirst.mockResolvedValue(null);
    kdsTicketCreate.mockResolvedValue({ id: 100 });

    const result = await createKdsTicketFromLog({
      userId: 1,
      area: 'Sallon',
      tableLabel: 'T2',
      items: [{ name: 'Pasta', qty: 2, categoryId: 1 }],
      note: 'no onion',
    });

    expect(result).toEqual({ orderNo: 5, ticketId: 100 });
    expect(kdsTicketCreate).toHaveBeenCalled();
    expect(kdsTicketUpdate).not.toHaveBeenCalled();
  });
});
