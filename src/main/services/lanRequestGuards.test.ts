import { describe, expect, it } from 'vitest';
import {
  eventStreamsToClose,
  isJsonContentType,
  isWriteMethod,
  MAX_EVENT_STREAMS_PER_DEVICE,
  parseOptionalIsoDate,
  tokenAllowedInQuery,
} from './lanRequestGuards';

describe('isJsonContentType', () => {
  it('accepts JSON with or without a charset', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType(['application/json'])).toBe(true);
  });

  it('refuses the types a browser sends without a preflight', () => {
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('text/plain;charset=UTF-8')).toBe(false);
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType('multipart/form-data; boundary=x')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType('')).toBe(false);
  });
});

describe('isWriteMethod', () => {
  it('flags methods that change state', () => {
    expect(isWriteMethod('POST')).toBe(true);
    expect(isWriteMethod('delete')).toBe(true);
    expect(isWriteMethod('GET')).toBe(false);
    expect(isWriteMethod('OPTIONS')).toBe(false);
    expect(isWriteMethod(undefined)).toBe(false);
  });
});

describe('parseOptionalIsoDate', () => {
  it('treats a missing value as no filter', () => {
    expect(parseOptionalIsoDate(undefined, 'startIso')).toEqual({
      ok: true,
      date: undefined,
    });
    expect(parseOptionalIsoDate('', 'startIso')).toEqual({
      ok: true,
      date: undefined,
    });
  });

  it('parses a valid date', () => {
    const r = parseOptionalIsoDate('2026-11-05T10:00:00.000Z', 'startIso');
    expect(r.ok && r.date?.toISOString()).toBe('2026-11-05T10:00:00.000Z');
  });

  it('rejects garbage instead of passing Invalid Date on', () => {
    expect(parseOptionalIsoDate('yesterday-ish', 'endIso')).toEqual({
      ok: false,
      error: 'invalid endIso',
    });
  });
});

describe('eventStreamsToClose', () => {
  const mk = (n: number, userId = 7, remoteIp = '10.0.0.5') =>
    Array.from({ length: n }, (_, i) => ({ id: i, userId, remoteIp }));

  it('keeps everything under the cap', () => {
    expect(eventStreamsToClose(mk(2), 7, '10.0.0.5')).toEqual([]);
  });

  it('closes the oldest so the new stream fits', () => {
    const open = mk(MAX_EVENT_STREAMS_PER_DEVICE);
    expect(eventStreamsToClose(open, 7, '10.0.0.5')).toEqual([open[0]]);
    const many = mk(MAX_EVENT_STREAMS_PER_DEVICE + 2);
    expect(eventStreamsToClose(many, 7, '10.0.0.5').map((c) => c.id)).toEqual([
      0, 1, 2,
    ]);
  });

  it('counts other users and other devices separately', () => {
    const open = [
      ...mk(MAX_EVENT_STREAMS_PER_DEVICE, 8),
      ...mk(MAX_EVENT_STREAMS_PER_DEVICE, 7, '10.0.0.6'),
    ];
    expect(eventStreamsToClose(open, 7, '10.0.0.5')).toEqual([]);
  });
});

describe('tokenAllowedInQuery', () => {
  it('allows the address token only on the live-update stream', () => {
    expect(tokenAllowedInQuery('/events')).toBe(true);
    expect(tokenAllowedInQuery('/admin/users')).toBe(false);
    expect(tokenAllowedInQuery('/events/login')).toBe(false);
    expect(tokenAllowedInQuery('/notifications')).toBe(false);
    expect(tokenAllowedInQuery(null)).toBe(false);
  });
});
