import { describe, expect, it } from 'vitest';
import { countQueuedActions } from './offlineQueue';

const table = { area: 'Salla', tableLabel: 'T3' };

describe('countQueuedActions (QA round 4, #2)', () => {
  it('one Send queued offline is one action, not three', () => {
    expect(
      countQueuedActions([
        {
          op: 'tables.setOpen',
          args: { area: 'Salla', label: 'T3', open: true },
        },
        { op: 'tickets.log', args: { ...table, idempotencyKey: 'k1' } },
        {
          op: 'tickets.print',
          args: { ...table, meta: { kind: 'ORDER', sendKey: 'k1' } },
        },
        { op: 'covers.save', args: { area: 'Salla', label: 'T3', covers: 2 } },
      ]),
    ).toBe(1);
  });

  it('counts each Send, payment and void', () => {
    expect(
      countQueuedActions([
        { op: 'tickets.log', args: { ...table, idempotencyKey: 'k1' } },
        {
          op: 'tickets.print',
          args: { ...table, meta: { kind: 'ORDER', sendKey: 'k1' } },
        },
        { op: 'tickets.log', args: { ...table, idempotencyKey: 'k2' } },
        { op: 'tickets.voidItem', args: { ...table } },
        {
          op: 'tickets.print',
          args: { ...table, meta: { kind: 'PAYMENT' } },
        },
      ]),
    ).toBe(4);
  });

  it('a table close on its own is still counted', () => {
    expect(
      countQueuedActions([
        {
          op: 'tables.setOpen',
          args: { area: 'Salla', label: 'T3', open: false },
        },
      ]),
    ).toBe(1);
  });
});
