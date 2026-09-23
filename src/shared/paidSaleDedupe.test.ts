import { describe, expect, it } from 'vitest';
import {
  isPaidSaleReprintMeta,
  keepCanonicalPaidOrders,
} from './paidSaleDedupe';

describe('paidSaleDedupe', () => {
  it('detects reprint payment meta', () => {
    expect(isPaidSaleReprintMeta({ kind: 'PAYMENT', reprint: true })).toBe(
      true,
    );
    expect(isPaidSaleReprintMeta({ kind: 'PAYMENT' })).toBe(false);
  });

  it('drops reprint Orders and keeps the fiscalized settlement', () => {
    const rows = [
      {
        id: 80,
        userId: 2,
        area: 'Salla',
        tableLabel: 'T7',
        total: 600,
        closedAt: 1790090419112,
        payments: [
          {
            metaJson: { kind: 'PAYMENT', reprint: true },
            fiscalNslf: null,
            fiscalNivf: null,
          },
        ],
      },
      {
        id: 79,
        userId: 2,
        area: 'Salla',
        tableLabel: 'T7',
        total: 600,
        closedAt: 1790090419112,
        payments: [
          {
            metaJson: { kind: 'PAYMENT' },
            fiscalNslf: 'ABC',
            fiscalNivf: 'def',
          },
        ],
      },
      {
        id: 81,
        userId: 2,
        area: 'Salla',
        tableLabel: 'T7',
        total: 1500,
        closedAt: 1790092739090,
        payments: [{ metaJson: { kind: 'PAYMENT' } }],
      },
    ];
    const kept = keepCanonicalPaidOrders(rows);
    expect(kept.map((r) => r.id)).toEqual([79, 81]);
  });
});
