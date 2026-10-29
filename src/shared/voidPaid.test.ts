import { describe, expect, it } from 'vitest';
import {
  hasPaidTicketLines,
  isPaidTicketLine,
  planItemVoid,
  planTicketVoid,
} from './voidPaid';

describe('planItemVoid', () => {
  it('voids the line with that id', () => {
    const items = [
      { lineId: 'a', name: 'Byrek', qty: 1, unitPrice: 300 },
      { lineId: 'b', name: 'Byrek', qty: 1, unitPrice: 300 },
    ];

    expect(planItemVoid(items, { lineId: 'b', name: 'Byrek' })).toEqual({
      outcome: 'ok',
      index: 1,
    });
  });

  it('refuses a line that has been paid for', () => {
    const items = [
      { lineId: 'a', name: 'Byrek', qty: 1, unitPrice: 300, paid: true },
    ];

    expect(planItemVoid(items, { lineId: 'a' })).toEqual({ outcome: 'paid' });
  });

  it('never falls back to another line with the same name', () => {
    // Seat 1 paid for their coffee; seat 2 has not. A void of the paid one
    // is refused, not moved onto the one still owed.
    const items = [
      { lineId: 'a', name: 'Kafe', qty: 1, unitPrice: 150, paid: true },
      { lineId: 'b', name: 'Kafe', qty: 1, unitPrice: 150 },
    ];

    expect(planItemVoid(items, { lineId: 'a', name: 'Kafe' })).toEqual({
      outcome: 'paid',
    });
    expect(planItemVoid(items, { lineId: 'zz', name: 'Kafe' })).toEqual({
      outcome: 'not-found',
    });
  });

  it('does not void by name alone', () => {
    const items = [{ lineId: 'a', name: 'Byrek', qty: 1, unitPrice: 300 }];

    expect(
      planItemVoid(items, { name: 'Byrek', qty: 1, unitPrice: 300 }),
    ).toEqual({ outcome: 'no-line-id' });
  });

  it('does not void an already voided line again', () => {
    const items = [
      { lineId: 'a', name: 'Kafe', qty: 1, unitPrice: 150, voided: true },
    ];

    expect(planItemVoid(items, { lineId: 'a' })).toEqual({
      outcome: 'not-found',
    });
  });
});

describe('planTicketVoid', () => {
  it('voids every line on an unpaid ticket', () => {
    const plan = planTicketVoid([
      { name: 'Byrek', paid: false },
      { name: 'Kafe' },
    ]);

    expect(plan).toEqual({
      outcome: 'ok',
      items: [
        { name: 'Byrek', paid: false, voided: true },
        { name: 'Kafe', voided: true },
      ],
      voidedCount: 2,
      keptPaidCount: 0,
    });
  });

  it('leaves paid lines standing and voids the rest', () => {
    const plan = planTicketVoid([
      { name: 'Kafe', paid: true },
      { name: 'Byrek' },
    ]);

    expect(plan).toEqual({
      outcome: 'ok',
      items: [
        { name: 'Kafe', paid: true },
        { name: 'Byrek', voided: true },
      ],
      voidedCount: 1,
      keptPaidCount: 1,
    });
  });

  it('refuses when the whole ticket has been paid for', () => {
    expect(
      planTicketVoid([
        { name: 'Kafe', paid: true },
        { name: 'Byrek', paid: true },
      ]),
    ).toEqual({ outcome: 'paid' });
  });

  it('refuses when the only unpaid lines are already voided', () => {
    expect(
      planTicketVoid([
        { name: 'Kafe', paid: true },
        { name: 'Byrek', voided: true },
      ]),
    ).toEqual({ outcome: 'paid' });
  });

  it('still clears a ticket that has nothing on it', () => {
    expect(planTicketVoid([])).toEqual({
      outcome: 'ok',
      items: [],
      voidedCount: 0,
      keptPaidCount: 0,
    });
  });
});

describe('line helpers', () => {
  it('reads the paid flag strictly', () => {
    expect(isPaidTicketLine({ paid: true })).toBe(true);
    expect(isPaidTicketLine({ paid: 'yes' })).toBe(false);
    expect(isPaidTicketLine({})).toBe(false);
    expect(isPaidTicketLine(null)).toBe(false);
  });

  it('spots a ticket carrying settled money', () => {
    expect(hasPaidTicketLines([{ name: 'a' }, { name: 'b', paid: true }])).toBe(
      true,
    );
    expect(hasPaidTicketLines([{ name: 'a' }])).toBe(false);
    expect(hasPaidTicketLines(null)).toBe(false);
  });
});
