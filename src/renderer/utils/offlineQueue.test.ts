/**
 * Tests for the offline queue's money-safety rules.
 *
 * These cover the pure decision logic rather than the IndexedDB plumbing:
 * whether a payment response counts as accepted, and what the queue is
 * allowed to shed when it overflows. Both were places where a sale could
 * previously be lost without trace.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPrintAccepted,
  isDurableOp,
  isMoneyOp,
  isPermanentFailure,
  needsManualReconciliation,
  planEviction,
  type OfflineOp,
} from './offlineQueue';

const item = (op: OfflineOp, id: string) => ({ op, id });

describe('isMoneyOp', () => {
  it('covers order creation and payments', () => {
    expect(isMoneyOp('tickets.log')).toBe(true);
    expect(isMoneyOp('payments.record')).toBe(true);
  });

  it('excludes advisory operations', () => {
    expect(isMoneyOp('covers.save')).toBe(false);
    // Freeing a table is durable but is not itself a money movement.
    expect(isMoneyOp('tables.setOpen')).toBe(false);
  });
});

describe('isDurableOp', () => {
  it('includes everything that moves money', () => {
    expect(isDurableOp('tickets.log')).toBe(true);
    expect(isDurableOp('payments.record')).toBe(true);
  });

  it('includes freeing a table, the other half of taking payment', () => {
    // Dropping this is what left paid tables showing occupied on the floor.
    expect(isDurableOp('tables.setOpen')).toBe(true);
  });

  it('includes kitchen prints so a lost response cannot reprint the chit', () => {
    expect(isDurableOp('tickets.print')).toBe(true);
    expect(isMoneyOp('tickets.print')).toBe(false);
  });

  it('still excludes genuinely advisory operations', () => {
    expect(isDurableOp('covers.save')).toBe(false);
  });

  it('is a superset of isMoneyOp', () => {
    const ops: OfflineOp[] = [
      'tickets.log',
      'tickets.print',
      'payments.record',
      'tables.setOpen',
      'covers.save',
    ];
    for (const op of ops) {
      if (isMoneyOp(op)) expect(isDurableOp(op), op).toBe(true);
    }
  });
});

describe('assertPrintAccepted', () => {
  it('accepts the success shapes both transports return', () => {
    expect(() => assertPrintAccepted(true)).not.toThrow();
    expect(() => assertPrintAccepted(undefined)).not.toThrow();
    expect(() => assertPrintAccepted({ ok: true })).not.toThrow();
  });

  it('throws when the host reports a hard failure', () => {
    // The IPC handler returns `false` when fiscalization is rejected.
    expect(() => assertPrintAccepted(false)).toThrow(/not recorded/i);
  });

  it('throws on an explicit rejection object', () => {
    expect(() => assertPrintAccepted({ ok: false, error: 'nope' })).toThrow(
      'nope',
    );
  });

  it('does not mark failures permanent, so they stay retryable', () => {
    // A fiscal outage is transient; marking it permanent would move the
    // payment straight to the failed surface instead of retrying.
    try {
      assertPrintAccepted(false);
      throw new Error('expected a throw');
    } catch (e: any) {
      expect(e.code).toBe('PAYMENT_NOT_RECORDED');
      expect(e.permanent).toBeUndefined();
    }
  });

  it('carries an explicit permanent flag through', () => {
    try {
      assertPrintAccepted({
        ok: false,
        code: 'FISCAL_NEEDS_REVIEW',
        error: 'outcome unknown',
        permanent: true,
      });
      throw new Error('expected a throw');
    } catch (e: any) {
      expect(e.code).toBe('FISCAL_NEEDS_REVIEW');
      expect(e.permanent).toBe(true);
    }
  });
});

describe('failure permanence', () => {
  it('never retries a fiscal outcome we could not determine', () => {
    // Re-sending this could file a second invoice with the tax service,
    // which then needs a corrective filing to undo.
    const e = { code: 'FISCAL_NEEDS_REVIEW' };
    expect(needsManualReconciliation(e)).toBe(true);
    expect(isPermanentFailure(e)).toBe(true);
  });

  it('keeps ordinary rejections off the reconciliation surface', () => {
    // The server told us nothing happened, so there is nothing for a
    // human to reconcile — the UI error is enough.
    const e = { permanent: true, code: 'TICKET_REJECTED' };
    expect(isPermanentFailure(e)).toBe(true);
    expect(needsManualReconciliation(e)).toBe(false);
  });

  it('leaves transient failures retryable', () => {
    const e = { code: 'PAYMENT_NOT_RECORDED' };
    expect(isPermanentFailure(e)).toBe(false);
    expect(needsManualReconciliation(e)).toBe(false);
  });
});

describe('planEviction', () => {
  it('is a no-op below the cap', () => {
    const items = [item('covers.save', 'a'), item('payments.record', 'b')];
    const plan = planEviction(items, 10);
    expect(plan.kept).toEqual(items);
    expect(plan.evicted).toEqual([]);
    expect(plan.spilled).toEqual([]);
  });

  it('sheds advisory operations oldest-first', () => {
    const items = [
      item('covers.save', 'old'),
      item('covers.save', 'new'),
      item('tables.setOpen', 'newest'),
    ];
    const plan = planEviction(items, 2);
    expect(plan.evicted.map((i) => i.id)).toEqual(['old']);
    expect(plan.kept.map((i) => i.id)).toEqual(['new', 'newest']);
    expect(plan.spilled).toEqual([]);
  });

  it('protects a pending table close by shedding advisory writes instead', () => {
    const items = [
      item('covers.save', 'c1'),
      item('tables.setOpen', 'close'),
      item('covers.save', 'c2'),
    ];
    const plan = planEviction(items, 1);
    expect(plan.kept.map((i) => i.id)).toEqual(['close']);
    expect(plan.evicted.map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(plan.spilled).toEqual([]);
  });

  it('protects a pending kitchen print the same way', () => {
    const items = [
      item('covers.save', 'c1'),
      item('tickets.print', 'chit'),
      item('covers.save', 'c2'),
    ];
    const plan = planEviction(items, 1);
    expect(plan.kept.map((i) => i.id)).toEqual(['chit']);
    expect(plan.evicted.map((i) => i.id)).toEqual(['c1', 'c2']);
  });

  it('protects money operations by shedding advisory ones instead', () => {
    const items = [
      item('payments.record', 'pay1'),
      item('covers.save', 'c1'),
      item('tickets.log', 'log1'),
      item('covers.save', 'c2'),
    ];
    const plan = planEviction(items, 2);
    expect(plan.kept.map((i) => i.id)).toEqual(['pay1', 'log1']);
    expect(plan.evicted.map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(plan.spilled).toEqual([]);
  });

  it('never deletes money outright — it spills to the failed surface', () => {
    const items = [
      item('payments.record', 'pay1'),
      item('payments.record', 'pay2'),
      item('tickets.log', 'log1'),
    ];
    const plan = planEviction(items, 2);
    expect(plan.evicted).toEqual([]);
    expect(plan.spilled.map((i) => i.id)).toEqual(['pay1']);
    expect(plan.kept.map((i) => i.id)).toEqual(['pay2', 'log1']);
    // Nothing may vanish: every input is accounted for somewhere.
    expect(
      [...plan.kept, ...plan.evicted, ...plan.spilled].map((i) => i.id).sort(),
    ).toEqual(['log1', 'pay1', 'pay2']);
  });

  it('accounts for every item under heavy overflow', () => {
    const items = [
      ...Array.from({ length: 300 }, (_, i) => item('covers.save', `c${i}`)),
      ...Array.from({ length: 400 }, (_, i) =>
        item('payments.record', `p${i}`),
      ),
    ];
    const plan = planEviction(items, 500);

    expect(plan.kept).toHaveLength(500);
    expect(plan.kept.length + plan.evicted.length + plan.spilled.length).toBe(
      700,
    );
    // All 400 payments must survive somewhere.
    const survivingPayments = [...plan.kept, ...plan.spilled].filter((i) =>
      i.id.startsWith('p'),
    );
    expect(survivingPayments).toHaveLength(400);
    // No payment may be in the discarded bucket.
    expect(plan.evicted.every((i) => i.id.startsWith('c'))).toBe(true);
  });

  it('spills only the oldest money when the queue is all money', () => {
    const items = Array.from({ length: 505 }, (_, i) =>
      item('payments.record', `p${i}`),
    );
    const plan = planEviction(items, 500);
    expect(plan.spilled.map((i) => i.id)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
    expect(plan.kept).toHaveLength(500);
    expect(plan.evicted).toEqual([]);
  });
});
