import { describe, expect, it } from 'vitest';
import {
  asTicketLogItems,
  rowIsInOpenSession,
  ticketCreatedAtIso,
  ticketLogCreatedAtMs,
  ticketLogCreatedAtRangeSql,
  ticketLogInRange,
} from './ticketLogItems';

describe('asTicketLogItems', () => {
  it('keeps a parsed array', () => {
    expect(asTicketLogItems([{ name: 'Byrek', qty: 1 }])).toEqual([
      { name: 'Byrek', qty: 1 },
    ]);
  });

  it('parses a JSON string from SQLite', () => {
    expect(asTicketLogItems('[{"name":"Cezar","qty":2}]')).toEqual([
      { name: 'Cezar', qty: 2 },
    ]);
  });

  it('treats missing or invalid payloads as no lines', () => {
    expect(asTicketLogItems(null)).toEqual([]);
    expect(asTicketLogItems('{not json')).toEqual([]);
    expect(asTicketLogItems({ name: 'Byrek' })).toEqual([]);
  });
});

describe('ticketLogCreatedAtMs', () => {
  it('reads Date, epoch ms, and ISO strings', () => {
    const iso = '2026-09-11T13:59:08.909Z';
    const ms = Date.parse(iso);
    expect(ticketLogCreatedAtMs(new Date(iso))).toBe(ms);
    expect(ticketLogCreatedAtMs(ms)).toBe(ms);
    expect(ticketLogCreatedAtMs(iso)).toBe(ms);
  });

  it('promotes epoch seconds', () => {
    expect(ticketLogCreatedAtMs(1_700_000_000)).toBe(1_700_000_000_000);
  });
});

describe('ticketCreatedAtIso', () => {
  it('serializes Date, epoch ms, and ISO strings', () => {
    const iso = '2026-09-11T13:59:08.909Z';
    expect(ticketCreatedAtIso(iso)).toBe(iso);
    expect(ticketCreatedAtIso(Date.parse(iso))).toBe(iso);
    expect(ticketCreatedAtIso(new Date(iso))).toBe(iso);
  });
});

describe('ticketLogInRange', () => {
  const iso = '2026-09-19T12:00:00.000Z';
  const ms = Date.parse(iso);

  it('keeps epoch-ms and ISO rows inside the window', () => {
    expect(ticketLogInRange(ms, ms - 1000, ms + 1000)).toBe(true);
    expect(ticketLogInRange(iso, ms - 1000, ms + 1000)).toBe(true);
    expect(ticketLogInRange(new Date(iso), ms - 1000, ms + 1000)).toBe(true);
  });

  it('drops rows outside the window', () => {
    expect(ticketLogInRange(ms, ms + 1, ms + 2000)).toBe(false);
    expect(ticketLogInRange(ms, ms - 2000, ms - 1)).toBe(false);
  });
});

describe('ticketLogCreatedAtRangeSql', () => {
  it('matches both INTEGER ms and TEXT ISO with bound params', () => {
    const start = Date.parse('2026-09-19T00:00:00.000Z');
    const end = Date.parse('2026-09-19T23:59:59.999Z');
    const q = ticketLogCreatedAtRangeSql(start, end);
    expect(q?.sql).toContain('typeof(createdAt)');
    const startSec = Math.floor(start / 1000);
    const endSec = Math.ceil(end / 1000);
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    expect(q?.sql).toContain("typeof(createdAt) IN ('integer', 'real')");
    expect(q?.sql).toContain("createdAt NOT GLOB '*[^0-9]*'");
    expect(q?.params).toEqual([
      start,
      end,
      startSec,
      endSec,
      startIso,
      endIso,
      start,
      end,
      startSec,
      endSec,
    ]);
  });

  it('is a no-op when no bounds are given', () => {
    expect(ticketLogCreatedAtRangeSql()).toBeNull();
  });
});

describe('rowIsInOpenSession', () => {
  const openAt = Date.parse('2026-09-11T13:55:42.708Z');

  it('keeps a ticket written after the table opened', () => {
    expect(rowIsInOpenSession('2026-09-11T13:59:08.909Z', openAt)).toBe(true);
    expect(rowIsInOpenSession(openAt + 60, openAt)).toBe(true);
  });

  it('drops a ticket from the previous sitting', () => {
    expect(rowIsInOpenSession('2026-09-10T10:00:00.000Z', openAt)).toBe(false);
  });
});
