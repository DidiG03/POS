import { describe, expect, it } from 'vitest';
import {
  hasPaidTicketLines,
  isPaidTicketLine,
  planItemVoid,
  planTicketVoid,
} from './voidPaid';

describe('planItemVoid', () => {
  it('voids an unpaid line', () => {
    const items = [{ name: 'Byrek', qty: 1, unitPrice: 300 }];

    expect(
      planItemVoid(items, { name: 'Byrek', qty: 1, unitPrice: 300 }),
    ).toEqual({ outcome: 'ok', index: 0 });
  });

  it('refuses a line that has been paid for', () => {
    const items = [{ name: 'Byrek', qty: 1, unitPrice: 300, paid: true }];

    expect(
      planItemVoid(items, { name: 'Byrek', qty: 1, unitPrice: 300 }),
    ).toEqual({ outcome: 'paid' });
  });

  it('voids the unpaid copy when the same dish appears twice', () => {
    // Seat 1 paid for their coffee; seat 2 has not. Voiding "Kafe" must take
    // the one still owed, never rewrite the settled one.
    const items = [
      { name: 'Kafe', qty: 1, unitPrice: 150, paid: true },
      { name: 'Kafe', qty: 1, unitPrice: 150 },
    ];

    expect(
      planItemVoid(items, { name: 'Kafe', qty: 1, unitPrice: 150 }),
    ).toEqual({ outcome: 'ok', index: 1 });
  });

  it('reports a missing line as not-found rather than paid', () => {
    const items = [{ name: 'Byrek', qty: 1, unitPrice: 300, paid: true }];

    expect(
      planItemVoid(items, { name: 'Sallatë', qty: 1, unitPrice: 500 }),
    ).toEqual({ outcome: 'not-found' });
  });

  it('does not resurrect an already voided line', () => {
    const items = [{ name: 'Kafe', qty: 1, unitPrice: 150, voided: true }];

    expect(
      planItemVoid(items, { name: 'Kafe', qty: 1, unitPrice: 150 }),
    ).toEqual({ outcome: 'not-found' });
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
