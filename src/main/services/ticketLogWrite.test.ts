import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ticketLogCreate, consume, storePlan } = vi.hoisted(() => ({
  ticketLogCreate: vi.fn(),
  consume: vi.fn(),
  storePlan: { value: false },
}));

vi.mock('@db/client', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) =>
      fn({ ticketLog: { create: ticketLogCreate } }),
    ),
  },
}));
vi.mock('./menuStock', () => ({ consumeMenuStockForTicketLines: consume }));
vi.mock('./license', () => ({ storePlanBlocksTables: () => storePlan.value }));

import { stockLinesFromPayload, writeTicketSnapshot } from './ticketLogWrite';

const SEND = {
  userId: 4,
  area: 'Salla',
  tableLabel: 'T3',
  covers: 2,
  items: [{ sku: 'BEER', name: 'Beer', qty: 2, unitPrice: 300 }],
  note: null,
  idempotencyKey: 'send-1',
  sessionKey: 'Salla\u001fT3\u001f2026-09-27T12:00:00.000Z',
  stockConsumeLines: [{ sku: 'BEER', qty: 2 }],
};

describe('writeTicketSnapshot', () => {
  beforeEach(() => {
    ticketLogCreate.mockReset();
    ticketLogCreate.mockResolvedValue({ id: 1 });
    consume.mockReset();
    storePlan.value = false;
  });

  it('writes the snapshot and counts stock down in the same transaction', async () => {
    expect(await writeTicketSnapshot(SEND)).toBe('written');
    expect(ticketLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 4,
        area: 'Salla',
        tableLabel: 'T3',
        idempotencyKey: 'send-1',
        sessionKey: SEND.sessionKey,
      }),
    });
    expect(consume).toHaveBeenCalledWith(
      expect.anything(),
      [{ sku: 'BEER', qty: 2 }],
      'daily',
    );
  });

  it('uses on-hand counts on the Store plan', async () => {
    storePlan.value = true;
    await writeTicketSnapshot(SEND);
    expect(consume.mock.calls[0][2]).toBe('onHand');
  });

  it('a replayed Send is a no-op and does not count stock twice', async () => {
    ticketLogCreate.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    expect(await writeTicketSnapshot(SEND)).toBe('duplicate');
    expect(consume).not.toHaveBeenCalled();
  });

  it('rethrows real write failures', async () => {
    ticketLogCreate.mockRejectedValue(new Error('disk full'));
    await expect(writeTicketSnapshot(SEND)).rejects.toThrow('disk full');
  });
});

describe('stockLinesFromPayload', () => {
  it('keeps well-formed lines only', () => {
    expect(
      stockLinesFromPayload([
        { sku: ' BEER ', qty: 2 },
        { sku: '', qty: 1 },
        { qty: 3 },
        { sku: 'WINE' },
        null,
      ]),
    ).toEqual([
      { sku: 'BEER', qty: 2 },
      { sku: 'WINE', qty: 1 },
    ]);
    expect(stockLinesFromPayload(undefined)).toEqual([]);
  });
});

describe('both Send paths share the write', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

  it('the till and the phone route both call writeTicketSnapshot', () => {
    const ipc = read('../index.ts');
    const lan = read('../api.ts');
    const ipcHandler = ipc.slice(ipc.indexOf("ipcHandle('tickets:log'"));
    const lanRoute = lan.slice(lan.indexOf("pathname === '/tickets')"));
    expect(ipcHandler.slice(0, 6000)).toContain('writeTicketSnapshot(');
    expect(lanRoute.slice(0, 6000)).toContain('writeTicketSnapshot(');
    expect(lanRoute.slice(0, 6000)).toContain('stockConsumeLines');
  });
});
