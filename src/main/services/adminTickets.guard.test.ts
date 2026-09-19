import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, 'adminTickets.ts'), 'utf8');

describe('admin tickets SQLite DateTime / itemsJson', () => {
  it('serializes createdAt without assuming a Date', () => {
    expect(src).toContain('ticketCreatedAtIso');
    expect(src).toContain('asTicketLogItems');
    expect(src).toContain('ticketLogCreatedAtRangeSql');
    expect(src).toContain('ticketLogCreatedAtMs');
    expect(src).not.toMatch(/createdAt\.toISOString\s*\(/);
    expect(src).not.toMatch(/Array\.isArray\(r\.itemsJson\)/);
  });

  it('lists staff who wrote tickets even if they did not clock in', () => {
    expect(src).toContain('(counts[id] ?? 0) > 0');
    expect(src).toContain('latestRowPerSession');
  });
});
