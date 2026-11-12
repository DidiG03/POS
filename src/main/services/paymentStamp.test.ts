import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ displayName: 'Ana' })) },
  },
}));

import { stampPayment, stampPaymentForSession } from './paymentStamp';

const now = new Date('2026-11-12T20:00:00.000Z');
const pay = (meta: Record<string, unknown> = {}, userName?: string): any => ({
  area: 'Main',
  tableLabel: '1',
  userName,
  items: [{ name: 'Espresso', qty: 1, unitPrice: 1 }],
  meta: { kind: 'PAYMENT', ...meta },
});

describe('stampPayment', () => {
  it('credits the signed-in user, not the one the device named', () => {
    const out = stampPayment(
      pay({ userId: 7 }, 'Someone Else'),
      { userId: 3, displayName: 'Ana' },
      now,
    ) as any;
    expect(out.meta.userId).toBe(3);
    expect(out.userName).toBe('Ana');
    expect(out.meta.deviceUserId).toBe(7);
  });

  it('drops a name that belongs to another user when ours is unknown', () => {
    const out = stampPayment(
      pay({ userId: 7 }, 'Someone Else'),
      { userId: 3 },
      now,
    ) as any;
    expect(out.meta.userId).toBe(3);
    expect(out.userName).toBeUndefined();
  });

  it('uses the till clock and keeps the device time beside it', () => {
    const out = stampPayment(
      pay({ paidAt: '2026-11-01T08:00:00.000Z' }),
      { userId: 3 },
      now,
    ) as any;
    expect(out.meta.paidAt).toBe(now.toISOString());
    expect(out.meta.devicePaidAt).toBe('2026-11-01T08:00:00.000Z');
  });

  it('still uses the till clock with nobody signed in', () => {
    const out = stampPayment(pay({ userId: 7, paidAt: 'x' }), null, now) as any;
    expect(out.meta.paidAt).toBe(now.toISOString());
    expect(out.meta.userId).toBe(7);
  });

  it('leaves reprints and kitchen slips as they are', () => {
    const reprint = pay({ reprint: true, userId: 7, paidAt: 'then' });
    expect(stampPayment(reprint, { userId: 3 }, now)).toBe(reprint);
    const slip = { ...pay(), meta: { kind: 'ORDER', userId: 7 } as any };
    expect(stampPayment(slip, { userId: 3 }, now)).toBe(slip);
  });

  it('does not change the payload it was given', () => {
    const input = pay({ userId: 7 });
    stampPayment(input, { userId: 3 }, now);
    expect(input.meta.userId).toBe(7);
  });
});

describe('stampPaymentForSession', () => {
  it('reads the name of the signed-in user', async () => {
    const out = (await stampPaymentForSession(
      pay({ userId: 7 }, 'Someone Else'),
      3,
      now,
    )) as any;
    expect(out.meta.userId).toBe(3);
    expect(out.userName).toBe('Ana');
  });
});
