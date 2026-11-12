import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));

import {
  DISCOUNT_THRESHOLD,
  LAST_PAYMENT_KEY,
  SERVICE_REMOVAL_THRESHOLD,
  UNUSUAL_PREFIX,
  VOID_ITEM_PREFIX,
  VOID_ITEM_THRESHOLD,
  VOID_TICKET_PREFIX,
  VOID_TICKET_THRESHOLD,
  __resetFraudAlertsForTests,
  checkPaymentForAlerts,
  checkVoidForAlerts,
} from './fraudAlerts';

type Note = { userId: number; type: string; message: string; createdAt: Date };

function fakeDb(now: () => number) {
  const notes: Note[] = [];
  const state = new Map<string, unknown>();
  return {
    notes,
    state,
    addVoidNotes(userId: number, prefix: string, n: number) {
      for (let i = 0; i < n; i++) {
        notes.push({
          userId,
          type: 'OTHER',
          message: `${prefix}Salla T${i}`,
          createdAt: new Date(now()),
        });
      }
    },
    securityNotes: () => notes.filter((n) => n.type === 'SECURITY'),
    // Voids are counted from the permanent record. The fake keeps them
    // with the notes, told apart by the same prefixes.
    billEvent: {
      count: async ({ where }: any) =>
        notes.filter(
          (n) =>
            n.type === 'OTHER' &&
            n.userId === where.actorUserId &&
            n.createdAt >= where.createdAt.gte &&
            n.message.startsWith(
              where.kind === 'VOID_TICKET'
                ? 'Voided ticket on '
                : 'Voided item on ',
            ),
        ).length,
    },
    notification: {
      count: async ({ where }: any) =>
        notes.filter(
          (n) =>
            n.userId === where.userId &&
            n.type === where.type &&
            n.createdAt >= where.createdAt.gte &&
            (where.message.startsWith
              ? n.message.startsWith(where.message.startsWith)
              : n.message.includes(where.message.includes)),
        ).length,
      create: async ({ data }: any) => {
        notes.push({ ...data, createdAt: new Date(now()) });
      },
    },
    user: {
      findUnique: async ({ where }: any) =>
        where.id === 7 ? { displayName: 'Arben' } : null,
      findMany: async () => [{ id: 1 }, { id: 2 }],
    },
    syncState: {
      findUnique: async ({ where }: any) =>
        state.has(where.key) ? { valueJson: state.get(where.key) } : null,
      upsert: async ({ where, create }: any) => {
        state.set(where.key, create.valueJson);
      },
    },
  };
}

let t = 0;
const now = () => t;
let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  t = 1_800_000_000_000;
  db = fakeDb(now);
  __resetFraudAlertsForTests();
});

const payment = (extra: Record<string, unknown> = {}) => ({
  actorUserId: 7,
  area: 'Salla',
  tableLabel: 'T4',
  meta: { kind: 'PAYMENT', ...extra },
});

describe('checkVoidForAlerts', () => {
  it('stays quiet below the threshold', async () => {
    db.addVoidNotes(7, VOID_ITEM_PREFIX, VOID_ITEM_THRESHOLD - 1);
    await checkVoidForAlerts(
      { actorUserId: 7, area: 'Salla', tableLabel: 'T4', kind: 'VOID_ITEM' },
      { db, now },
    );
    expect(db.securityNotes()).toEqual([]);
  });

  it('tells every admin once about many item voids by one person', async () => {
    db.addVoidNotes(7, VOID_ITEM_PREFIX, VOID_ITEM_THRESHOLD);
    const input = {
      actorUserId: 7,
      area: 'Salla',
      tableLabel: 'T4',
      kind: 'VOID_ITEM' as const,
    };
    await checkVoidForAlerts(input, { db, now });
    await checkVoidForAlerts(input, { db, now });
    const sent = db.securityNotes();
    expect(sent.map((n) => n.userId)).toEqual([1, 2]);
    expect(sent[0]!.message).toContain(UNUSUAL_PREFIX);
    expect(sent[0]!.message).toContain(`${VOID_ITEM_THRESHOLD} voided items`);
    expect(sent[0]!.message).toContain('Arben');
  });

  it('uses the lower threshold for whole-ticket voids', async () => {
    db.addVoidNotes(7, VOID_TICKET_PREFIX, VOID_TICKET_THRESHOLD);
    await checkVoidForAlerts(
      { actorUserId: 7, area: 'Salla', tableLabel: 'T4', kind: 'VOID_TICKET' },
      { db, now },
    );
    expect(db.securityNotes()[0]!.message).toContain('voided tickets');
  });

  it('flags a void shortly after that table was paid, not a later one', async () => {
    await checkPaymentForAlerts(payment(), { db, now });
    t += 4 * 60_000;
    await checkVoidForAlerts(
      { actorUserId: 7, area: 'Salla', tableLabel: 'T4', kind: 'VOID_ITEM' },
      { db, now },
    );
    expect(db.securityNotes()).toHaveLength(2);
    expect(db.securityNotes()[0]!.message).toContain(
      'about 4 minutes after payment',
    );

    db.notes.length = 0;
    t += 30 * 60_000;
    await checkVoidForAlerts(
      { actorUserId: 7, area: 'Salla', tableLabel: 'T4', kind: 'VOID_ITEM' },
      { db, now },
    );
    expect(db.securityNotes()).toEqual([]);
  });

  it('ignores a void on another table', async () => {
    await checkPaymentForAlerts(payment(), { db, now });
    await checkVoidForAlerts(
      { actorUserId: 7, area: 'Salla', tableLabel: 'T9', kind: 'VOID_ITEM' },
      { db, now },
    );
    expect(db.securityNotes()).toEqual([]);
  });
});

describe('checkPaymentForAlerts', () => {
  it('remembers when each table was paid', async () => {
    await checkPaymentForAlerts(payment(), { db, now });
    const map = db.state.get(LAST_PAYMENT_KEY) as Record<string, string>;
    expect(map['Salla:T4']).toBe(new Date(t).toISOString());
  });

  it('alerts on repeated discounts, once per hour', async () => {
    for (let i = 0; i < DISCOUNT_THRESHOLD - 1; i++) {
      await checkPaymentForAlerts(payment({ discountAmount: 2 }), { db, now });
    }
    expect(db.securityNotes()).toEqual([]);
    await checkPaymentForAlerts(payment({ discountAmount: 2 }), { db, now });
    await checkPaymentForAlerts(payment({ discountAmount: 2 }), { db, now });
    const sent = db.securityNotes();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.message).toContain(
      `${DISCOUNT_THRESHOLD} discounted payments by Arben`,
    );
  });

  it('alerts on repeated service-charge removals', async () => {
    for (let i = 0; i < SERVICE_REMOVAL_THRESHOLD; i++) {
      await checkPaymentForAlerts(
        payment({
          serviceChargeEnabled: true,
          serviceChargeApplied: false,
          serviceChargeAmount: 1.5,
        }),
        { db, now },
      );
    }
    expect(db.securityNotes()[0]!.message).toContain('service charge removals');
  });

  it('does not count a receipt reprint or a kitchen slip', async () => {
    for (let i = 0; i < DISCOUNT_THRESHOLD + 2; i++) {
      await checkPaymentForAlerts(
        payment({ discountAmount: 2, reprint: true }),
        { db, now },
      );
      await checkPaymentForAlerts(
        { ...payment(), meta: { kind: 'ORDER', discountAmount: 2 } },
        { db, now },
      );
    }
    expect(db.securityNotes()).toEqual([]);
    expect(db.state.has(LAST_PAYMENT_KEY)).toBe(false);
  });

  it('starts counting again after the hour', async () => {
    for (let i = 0; i < DISCOUNT_THRESHOLD - 1; i++) {
      await checkPaymentForAlerts(payment({ discountAmount: 2 }), { db, now });
    }
    t += 61 * 60_000;
    await checkPaymentForAlerts(payment({ discountAmount: 2 }), { db, now });
    expect(db.securityNotes()).toEqual([]);
  });
});
