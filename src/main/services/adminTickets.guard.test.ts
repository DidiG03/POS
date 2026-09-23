import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, 'adminTickets.ts'), 'utf8');
const staffPage = fs.readFileSync(
  path.resolve(__dirname, '../../renderer/app/pages/AdminTicketsPage.tsx'),
  'utf8',
);

describe('admin tickets SQLite DateTime / itemsJson', () => {
  it('serializes createdAt without assuming a Date', () => {
    expect(src).toContain('ticketCreatedAtIso');
    expect(src).toContain('asTicketLogItems');
    expect(src).toContain('ticketLogCreatedAtRangeSql');
    expect(src).toContain('ticketLogCreatedAtMs');
    expect(src).not.toMatch(/createdAt\.toISOString\s*\(/);
    expect(src).not.toMatch(/Array\.isArray\(r\.itemsJson\)/);
  });

  it('always returns every waiter, not only staff who clocked in', () => {
    expect(src).toContain("role: { not: 'ADMIN' }");
    expect(src).not.toContain('clockedInDuringPeriod');
    expect(src).toContain('unionTicketLogsById');
    expect(src).toContain('paidSalesNotOnTickets');
    expect(src).toContain('matchOrdersToTicketRows');
    expect(src).toContain('keepCanonicalPaidOrders');
  });

  it('staff list defaults to today and shows per-waiter metrics', () => {
    expect(staffPage).not.toContain('computeDateRange');
    expect(staffPage).not.toContain('clockedIn');
    expect(staffPage).toContain('listTicketCounts(dayRange)');
    expect(staffPage).toContain('todayRangeIso');
    expect(staffPage).toContain('Paid');
    expect(staffPage).toContain('Active');
    expect(staffPage).toContain('Voided');
    expect(staffPage).toContain('Total');
    expect(staffPage).toContain('Search staff');
  });
});
