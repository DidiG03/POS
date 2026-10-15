/**
 * Queued writes for one table are delivered in order, carry their
 * idempotency key from the first attempt, and a refused void is a failure.
 */
import { describe, expect, it } from 'vitest';
import {
  assertVoidAccepted,
  createTableOrder,
  queuedItemTables,
  withIdempotencyKey,
  type OfflineOp,
} from './offlineQueue';

const order = (table: string) => ({
  op: 'tickets.log' as OfflineOp,
  args: { area: 'Salla', tableLabel: table },
});
const pay = (table: string) => ({
  op: 'payments.record' as OfflineOp,
  args: { area: 'Salla', tableLabel: table },
});
const covers = (table: string) => ({
  op: 'covers.save' as OfflineOp,
  args: { area: 'Salla', label: table },
});

describe('queuedItemTables', () => {
  it('reads the table of every op shape', () => {
    expect(queuedItemTables(order('4'))).toEqual(['Salla\u00014']);
    expect(queuedItemTables(covers('4'))).toEqual(['Salla\u00014']);
    expect(
      queuedItemTables({
        op: 'tables.transfer',
        args: {
          fromArea: 'Salla',
          fromLabel: '4',
          toArea: 'Bar',
          toLabel: '1',
        },
      }),
    ).toEqual(['Salla\u00014', 'Bar\u00011']);
    expect(queuedItemTables({ op: 'tickets.print', args: {} })).toEqual([]);
  });
});

describe('createTableOrder', () => {
  it('holds a payment behind an order still waiting for the same table', () => {
    const o = createTableOrder();
    o.hold(order('4')); // backing off after a blip
    expect(o.waits(pay('4'))).toBe(true);
    // Other tables are not held up.
    expect(o.waits(pay('5'))).toBe(false);
  });

  it('a waiting payment holds a later close of the same table', () => {
    const o = createTableOrder();
    o.hold(pay('4'));
    expect(
      o.waits({ op: 'tables.setOpen', args: { area: 'Salla', label: '4' } }),
    ).toBe(true);
  });

  it('advisory writes never hold anything up', () => {
    const o = createTableOrder();
    o.hold(covers('4'));
    expect(o.waits(pay('4'))).toBe(false);
  });

  it('a transfer holds both tables', () => {
    const o = createTableOrder();
    o.hold({
      op: 'tables.transfer',
      args: { fromArea: 'Salla', fromLabel: '4', toArea: 'Bar', toLabel: '1' },
    });
    expect(o.waits(order('4'))).toBe(true);
    expect(
      o.waits({ op: 'tickets.log', args: { area: 'Bar', tableLabel: '1' } }),
    ).toBe(true);
  });
});

describe('withIdempotencyKey', () => {
  it('mints a key for a void before its first attempt, once', () => {
    const args = { area: 'Salla', tableLabel: '4', item: { name: 'Uje' } };
    const keyed = withIdempotencyKey('tickets.voidItem', args);
    expect(String(keyed.idempotencyKey)).not.toBe('');
    expect(withIdempotencyKey('tickets.voidItem', keyed)).toBe(keyed);
    expect(args).not.toHaveProperty('idempotencyKey');
  });

  it('keeps a key the caller made', () => {
    const args = { idempotencyKey: 'tap-1' };
    expect(withIdempotencyKey('payments.record', args)).toBe(args);
  });

  it('leaves level-triggered writes alone', () => {
    const args = { area: 'Salla', label: '4', open: false };
    expect(withIdempotencyKey('tables.setOpen', args)).toBe(args);
  });
});

describe('assertVoidAccepted', () => {
  it('turns a refused void into a permanent failure', () => {
    expect(() => assertVoidAccepted(false)).toThrow(
      expect.objectContaining({ code: 'VOID_REJECTED', permanent: true }),
    );
  });

  it('accepts what the LAN client and the till return on success', () => {
    expect(() => assertVoidAccepted(true)).not.toThrow();
    expect(() => assertVoidAccepted(undefined)).not.toThrow();
  });
});
