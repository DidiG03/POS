import { beforeEach, describe, expect, it, vi } from 'vitest';

const orderFindFirst = vi.fn();
const orderCreate = vi.fn();
const orderUpdate = vi.fn();
const userFindUnique = vi.fn();
const tableFindFirst = vi.fn();
const menuItemFindMany = vi.fn();

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./core', () => ({
  coreServices: { readSettings: vi.fn().mockResolvedValue({}) },
}));
vi.mock('./license', () => ({ storePlanBlocksTables: () => false }));
vi.mock('./menuStock', () => ({
  consumeMenuStockForTicketLines: vi.fn(),
  stockLinesFromTicketItems: () => [],
}));

import { writeSettledSale } from './salesLedger';

function db() {
  return {
    order: {
      findFirst: (...a: any[]) => orderFindFirst(...a),
      create: (...a: any[]) => orderCreate(...a),
      update: (...a: any[]) => orderUpdate(...a),
    },
    user: { findUnique: (...a: any[]) => userFindUnique(...a) },
    table: { findFirst: (...a: any[]) => tableFindFirst(...a) },
    menuItem: { findMany: (...a: any[]) => menuItemFindMany(...a) },
    printJob: {},
  };
}

const payload = {
  area: 'Sallon',
  tableLabel: '12',
  covers: 2,
  userName: 'Ada',
  items: [{ sku: 'P1', name: 'Pizza', qty: 1, unitPrice: 1200, vatRate: 0.2 }],
  meta: {
    kind: 'PAYMENT',
    method: 'CASH',
    userId: 7,
    vatEnabled: true,
    totalAfter: 1200,
    paidAt: '2026-09-05T20:00:00.000Z',
  },
};

describe('writeSettledSale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orderFindFirst.mockResolvedValue(null);
    orderCreate.mockResolvedValue({ id: 44 });
    userFindUnique.mockResolvedValue({ id: 7, displayName: 'Ada' });
    tableFindFirst.mockResolvedValue({ id: 3 });
    menuItemFindMany.mockResolvedValue([{ id: 9, sku: 'P1' }]);
  });

  it('ignores kitchen slips', async () => {
    const r = await writeSettledSale(db(), {
      payload: { ...payload, meta: { kind: 'ORDER' } },
    });
    expect(r).toBeNull();
    expect(orderCreate).not.toHaveBeenCalled();
  });

  it('does not create a second sale for a Reports payment reprint', async () => {
    const r = await writeSettledSale(db(), {
      payload: {
        ...payload,
        meta: { ...payload.meta, reprint: true, closeTable: false },
      },
      idempotencyKey: 'reprint-1',
      printJobId: 99,
    });
    expect(r).toBeNull();
    expect(orderCreate).not.toHaveBeenCalled();
  });

  it('writes Order + items + Payment for a PAYMENT payload', async () => {
    const r = await writeSettledSale(db(), {
      payload,
      idempotencyKey: 'pay-1',
      printJobId: 88,
    });
    expect(r).toEqual({ orderId: 44, created: true });
    const data = orderCreate.mock.calls[0][0].data;
    expect(data.status).toBe('PAID');
    expect(data.area).toBe('Sallon');
    expect(data.tableLabel).toBe('12');
    expect(data.userId).toBe(7);
    expect(data.tableId).toBe(3);
    expect(data.idempotencyKey).toBe('pay-1');
    expect(data.printJobId).toBe(88);
    expect(data.total).toBe('1200.00');
    expect(data.items.create).toHaveLength(1);
    expect(data.items.create[0].menuItemId).toBe(9);
    expect(data.payments.create.method).toBe('CASH');
    expect(data.payments.create.idempotencyKey).toBe('pay-1');
  });

  it('does not insert twice for the same idempotency key', async () => {
    orderFindFirst.mockResolvedValue({ id: 44, printJobId: 88 });
    const r = await writeSettledSale(db(), {
      payload,
      idempotencyKey: 'pay-1',
      printJobId: 88,
    });
    expect(r).toEqual({ orderId: 44, created: false });
    expect(orderCreate).not.toHaveBeenCalled();
  });
});
