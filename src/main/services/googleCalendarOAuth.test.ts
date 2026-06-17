import { describe, expect, it } from 'vitest';
import { formatGoogleApiError, mapGoogleApiEvent } from './googleCalendarOAuth';

describe('formatGoogleApiError', () => {
  it('explains when Calendar API is disabled', () => {
    const msg = formatGoogleApiError(
      'Google Calendar API has not been used in project 464497287855 before or it is disabled.',
    );
    expect(msg).toContain('Google Calendar API is not enabled');
    expect(msg).toContain('464497287855');
  });
});

describe('mapGoogleApiEvent', () => {
  it('maps timed events', () => {
    const mapped = mapGoogleApiEvent({
      id: 'evt1',
      summary: 'Guest Name (4)',
      description: 'phone: +355691234567',
      start: { dateTime: '2026-06-13T20:00:00+02:00' },
      end: { dateTime: '2026-06-13T22:00:00+02:00' },
      status: 'confirmed',
    });
    expect(mapped?.uid).toBe('evt1');
    expect(mapped?.summary).toBe('Guest Name (4)');
    expect(mapped?.cancelled).toBe(false);
  });

  it('maps cancelled events', () => {
    const mapped = mapGoogleApiEvent({
      id: 'evt2',
      summary: 'Cancelled Guest',
      start: { dateTime: '2026-06-14T12:00:00+02:00' },
      status: 'cancelled',
    });
    expect(mapped?.cancelled).toBe(true);
  });
});
