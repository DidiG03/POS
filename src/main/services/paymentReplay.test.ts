import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  open: new Set<string>(),
  openedAt: new Map<string, Date>(),
  closed: [] as string[],
}));

vi.mock('./core', () => ({
  coreServices: {
    isTableOpen: async (a: string, l: string) => h.open.has(`${a}|${l}`),
  },
  withTableLock: (_a: string, _l: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./tableOpen', () => ({
  applyTableOpenState: async (a: string, l: string) => {
    h.closed.push(`${a}|${l}`);
    h.open.delete(`${a}|${l}`);
    return true;
  },
}));
vi.mock('./tableOccupancy', () => ({
  getOpenedAt: async (a: string, l: string) =>
    h.openedAt.get(`${a}|${l}`) ?? null,
}));
vi.mock('./paidLines', () => ({ recordPaidLinesOnBill: vi.fn() }));

import { PAYMENT_KEY_REUSED, answerRecordedRequest } from './paymentSettle';

const paidAt = new Date('2026-11-17T12:00:00Z');
const payment = (over: Record<string, unknown> = {}) => ({
  createdAt: paidAt,
  payloadJson: {
    area: 'Main',
    tableLabel: 'T13',
    meta: { kind: 'PAYMENT', closeTable: true, ...over },
  },
});

beforeEach(() => {
  h.open.clear();
  h.openedAt.clear();
  h.closed = [];
});

describe('answerRecordedRequest', () => {
  it('refuses a used key sent for another table, and closes nothing', async () => {
    h.open.add('Main|T14');
    const r = await answerRecordedRequest(payment(), {
      area: 'Main',
      tableLabel: 'T14',
    });
    expect(r).toMatchObject({ ok: false, code: PAYMENT_KEY_REUSED });
    expect(h.closed).toEqual([]);
  });

  it('never closes a table because of a kitchen slip key', async () => {
    h.open.add('Main|T13');
    const slip = {
      createdAt: paidAt,
      payloadJson: { area: 'Main', tableLabel: 'T13', meta: { kind: 'ORDER' } },
    };
    const r = await answerRecordedRequest(slip, {
      area: 'Main',
      tableLabel: 'T13',
    });
    expect(r.ok).toBe(true);
    expect(h.closed).toEqual([]);
  });

  it('finishes a real retry: closes the table the payment was for', async () => {
    h.open.add('Main|T13');
    h.openedAt.set('Main|T13', new Date(paidAt.getTime() - 3600e3));
    const r = await answerRecordedRequest(payment(), {
      area: 'Main',
      tableLabel: 'T13',
    });
    expect(r).toMatchObject({ ok: true, tableClosed: true });
    expect(h.closed).toEqual(['Main|T13']);
  });

  it('leaves the next party alone when a retry arrives after they sat down', async () => {
    h.open.add('Main|T13');
    h.openedAt.set('Main|T13', new Date(paidAt.getTime() + 600e3));
    const r = await answerRecordedRequest(payment(), {
      area: 'Main',
      tableLabel: 'T13',
    });
    expect(r).toMatchObject({ ok: true, tableClosed: false });
    expect(h.closed).toEqual([]);
  });

  it('does not close for a seat payment that left the table open', async () => {
    h.open.add('Main|T13');
    await answerRecordedRequest(payment({ closeTable: false }), {
      area: 'Main',
      tableLabel: 'T13',
    });
    expect(h.closed).toEqual([]);
  });
});
