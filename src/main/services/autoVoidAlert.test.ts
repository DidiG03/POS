import { beforeEach, describe, expect, it, vi } from 'vitest';

const { alerts } = vi.hoisted(() => ({ alerts: [] as any[] }));

vi.mock('./adminAlerts', () => ({
  notifyAdminsAndActor: vi.fn(async (input: any) => {
    alerts.push(input);
  }),
}));

import {
  autoVoidAlertMessage,
  notifyAutoVoidedTable,
  unpaidTicketValue,
} from './autoVoidAlert';

beforeEach(() => {
  alerts.length = 0;
});

describe('unpaidTicketValue', () => {
  it('counts only lines still owed', () => {
    expect(
      unpaidTicketValue([
        { name: 'Pizza', qty: 2, unitPrice: 700 },
        { name: 'Voided', qty: 1, unitPrice: 300, voided: true },
        { name: 'Paid seat', qty: 1, unitPrice: 400, paid: true },
        { name: 'Bad', qty: 0, unitPrice: 100 },
        { name: 'Beer', qty: 1, unitPrice: 250.5 },
      ]),
    ).toEqual({ count: 2, value: 1650.5 });
  });

  it('handles a missing or malformed ticket', () => {
    expect(unpaidTicketValue(null)).toEqual({ count: 0, value: 0 });
    expect(unpaidTicketValue('x')).toEqual({ count: 0, value: 0 });
  });
});

describe('notifyAutoVoidedTable', () => {
  it('tells admins what was erased, with the value and the waiter', async () => {
    const sent = await notifyAutoVoidedTable({
      area: 'Salla',
      tableLabel: 'T4',
      items: [{ name: 'Pizza', qty: 2, unitPrice: 700 }],
      currency: 'ALL',
      actorUserId: 5,
      waiterName: 'Ana',
    });
    expect(sent).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ actorUserId: 5, type: 'SECURITY' });
    expect(alerts[0].message).toContain('Salla Table T4');
    expect(alerts[0].message).toContain('1 unpaid item(s) worth 1400.00 ALL');
    expect(alerts[0].message).toContain('waiter Ana');
    expect(alerts[0].message).toContain('never reported to fiskalizimi');
  });

  it('stays quiet for a table with nothing owed', async () => {
    expect(
      await notifyAutoVoidedTable({
        area: 'Salla',
        tableLabel: 'T4',
        items: [{ name: 'x', qty: 1, unitPrice: 5, paid: true }],
        currency: 'ALL',
      }),
    ).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it('builds a readable message without optional details', () => {
    expect(
      autoVoidAlertMessage({
        area: 'Bar',
        tableLabel: '2',
        count: 3,
        value: 900,
        currency: 'EUR',
      }),
    ).toMatch(/^Auto-voided Bar Table 2: 3 unpaid item\(s\) worth 900\.00 EUR/);
  });
});
