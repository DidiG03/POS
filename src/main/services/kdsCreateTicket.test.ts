/**
 * Run with: pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const userFindUnique = vi.fn();
const kdsOrderFindFirst = vi.fn();
const kdsDayCounterUpsert = vi.fn();
const kdsDayCounterUpdate = vi.fn();
const kdsOrderCreate = vi.fn();
const kdsTicketFindMany = vi.fn();
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
          findMany: (...a: any[]) => kdsTicketFindMany(...a),
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
      lines.map((l) => ({
        ...l,
        station: l.station || 'KITCHEN',
      })),
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
      categoryIdToSortOrder: {},
      skuToKdsStation: {},
      skuToCategoryId: {},
    });
    kdsOrderFindFirst.mockResolvedValue({ id: 10, orderNo: 5 });
    kdsTicketStationFindFirst.mockResolvedValue(null);
  });

  it('merges fireItems into an existing NEW ticket of the same course', async () => {
    kdsTicketFindMany.mockResolvedValue([
      {
        id: 99,
        itemsJson: [{ name: 'Soup', qty: 1, station: 'KITCHEN' }],
      },
    ]);

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
    kdsTicketFindMany.mockResolvedValue([]);
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

  it('opens a new KDS card when the fire is a different course', async () => {
    kdsTicketFindMany.mockResolvedValue([
      {
        id: 99,
        itemsJson: [
          { name: 'Soup', qty: 1, station: 'KITCHEN', courseId: 'c1' },
        ],
      },
    ]);
    kdsTicketCreate.mockResolvedValue({ id: 101 });

    const result = await createKdsTicketFromLog({
      userId: 1,
      area: 'Sallon',
      tableLabel: 'T1',
      items: [],
      fireItems: [{ name: 'Steak', qty: 1, categoryId: 1, courseId: 'c2' }],
      note: 'no onion',
      courseLabel: 'Course 2',
    });

    expect(result).toEqual({ orderNo: 5, ticketId: 101 });
    expect(kdsTicketUpdate).not.toHaveBeenCalled();
    expect(kdsTicketCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        note: 'Course 2 · no onion',
        itemsJson: [
          {
            name: 'Steak',
            qty: 1,
            categoryId: 1,
            courseId: 'c2',
            station: 'KITCHEN',
          },
        ],
      }),
    });
  });

  it('writes drinks as their own card before the kitchen course', async () => {
    kdsTicketFindMany.mockResolvedValue([]);
    kdsTicketCreate
      .mockResolvedValueOnce({ id: 200 })
      .mockResolvedValueOnce({ id: 201 });

    const result = await createKdsTicketFromLog({
      userId: 1,
      area: 'Sallon',
      tableLabel: 'T1',
      items: [],
      fireItems: [
        { name: 'Cola', qty: 1, station: 'BAR' },
        { name: 'Soup', qty: 1, categoryId: 1, courseId: 'c1' },
      ],
      note: null,
      courseLabel: 'Course 1',
    });

    expect(result).toEqual({ orderNo: 5, ticketId: 201 });
    expect(kdsTicketCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        note: null,
        itemsJson: [{ name: 'Cola', qty: 1, station: 'BAR' }],
      }),
    });
    expect(kdsTicketCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        note: 'Course 1',
        itemsJson: [
          {
            name: 'Soup',
            qty: 1,
            categoryId: 1,
            courseId: 'c1',
            station: 'KITCHEN',
          },
        ],
      }),
    });
  });

  it('does not create a ticket when KDS is turned off', async () => {
    readSettings.mockResolvedValue({
      kds: { enabled: false, stations: { KITCHEN: true } },
    });

    const result = await createKdsTicketFromLog({
      userId: 1,
      area: 'Sallon',
      tableLabel: 'T3',
      items: [{ name: 'Pasta', qty: 1, categoryId: 1 }],
      note: null,
    });

    expect(result).toBeNull();
    expect(kdsTicketCreate).not.toHaveBeenCalled();
    expect(loadKdsRoutingFromDb).not.toHaveBeenCalled();
  });
});
