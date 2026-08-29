import { describe, expect, it } from 'vitest';
import {
  mapCalendarEventToReservation,
  parseIcalDateTime,
  parseIcalEvents,
  type ParsedCalendarEvent,
} from './googleCalendarSync';

describe('parseIcalDateTime', () => {
  it('parses local datetime', () => {
    const dt = parseIcalDateTime('20260613T193000');
    expect(dt?.getFullYear()).toBe(2026);
    expect(dt?.getMonth()).toBe(5);
    expect(dt?.getDate()).toBe(13);
    expect(dt?.getHours()).toBe(19);
    expect(dt?.getMinutes()).toBe(30);
  });

  it('parses UTC datetime', () => {
    const dt = parseIcalDateTime('20260613T173000Z');
    expect(dt?.toISOString()).toBe('2026-06-13T17:30:00.000Z');
  });
});

describe('parseIcalEvents', () => {
  it('extracts events with description and cancellation', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:abc-123',
      'SUMMARY:Arben Krasniqi (4)',
      'DESCRIPTION:phone: +355691234567\\nparty: 4\\narea: Terrace\\ntable: T2',
      'DTSTART:20260613T200000',
      'DTEND:20260613T220000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cancelled-1',
      'SUMMARY:Cancelled Guest',
      'DTSTART:20260614T120000',
      'STATUS:CANCELLED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseIcalEvents(ical);
    expect(events).toHaveLength(2);
    expect(events[0].uid).toBe('abc-123');
    expect(events[0].summary).toBe('Arben Krasniqi (4)');
    expect(events[0].description).toContain('+355691234567');
    expect(events[1].cancelled).toBe(true);
  });
});

describe('mapCalendarEventToReservation', () => {
  const baseEvent: ParsedCalendarEvent = {
    uid: 'x',
    summary: 'Guest Name (6)',
    description:
      'phone: +355 69 123 4567\narea: Main Hall\ntable: 5\nnote: Birthday',
    startsAt: new Date(2026, 5, 13, 20, 0, 0),
    endsAt: new Date(2026, 5, 13, 22, 0, 0),
    cancelled: false,
  };

  it('maps structured description fields', () => {
    const mapped = mapCalendarEventToReservation(baseEvent, {
      defaultArea: 'Terrace',
      defaultDurationMin: 90,
    });
    expect(mapped.customerName).toBe('Guest Name');
    expect(mapped.partySize).toBe(6);
    expect(mapped.customerPhone).toBe('+355 69 123 4567');
    expect(mapped.area).toBe('Main Hall');
    expect(mapped.tableLabel).toBeNull();
    expect(mapped.note).toBe('Birthday');
    expect(mapped.durationMin).toBe(120);
    expect(mapped.status).toBe('BOOKED');
  });

  it('does not invent a hardcoded area when none is configured', () => {
    const mapped = mapCalendarEventToReservation(
      { ...baseEvent, description: 'phone: +355 69 123 4567' },
      {},
    );
    expect(mapped.area).toBe('');
  });

  it('marks cancelled events', () => {
    const mapped = mapCalendarEventToReservation(
      { ...baseEvent, cancelled: true },
      { defaultArea: 'Main Hall' },
    );
    expect(mapped.status).toBe('CANCELLED');
  });
});
