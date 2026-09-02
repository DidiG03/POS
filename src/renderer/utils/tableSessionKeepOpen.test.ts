import { describe, expect, it } from 'vitest';
import {
  cacheLooksLikeCurrentSession,
  shouldKeepCoversOnlyTableOpen,
} from './tableSessionKeepOpen';

describe('shouldKeepCoversOnlyTableOpen', () => {
  it('keeps a covers-only sit with no ticket lines', () => {
    expect(
      shouldKeepCoversOnlyTableOpen({
        latestHadLines: false,
        localCovers: 2,
      }),
    ).toBe(true);
  });

  it('keeps the sit during the open handshake even before covers persist', () => {
    expect(
      shouldKeepCoversOnlyTableOpen({
        latestHadLines: false,
        suppressClose: true,
        localCovers: undefined,
        serverCovers: null,
      }),
    ).toBe(true);
  });

  it('frees the table when there is no ticket and no covers', () => {
    expect(
      shouldKeepCoversOnlyTableOpen({
        latestHadLines: false,
        localCovers: null,
        serverCovers: null,
      }),
    ).toBe(false);
  });

  it('still frees after every line was voided, even if covers remain', () => {
    expect(
      shouldKeepCoversOnlyTableOpen({
        latestHadLines: true,
        localCovers: 4,
      }),
    ).toBe(false);
  });
});

describe('cacheLooksLikeCurrentSession', () => {
  it('rejects a ticket cached before this sitting opened', () => {
    expect(
      cacheLooksLikeCurrentSession(
        { createdAt: '2026-09-02T10:00:00.000Z' },
        '2026-09-02T12:00:00.000Z',
      ),
    ).toBe(false);
  });

  it('accepts a ticket cached at or after openAt', () => {
    expect(
      cacheLooksLikeCurrentSession(
        { createdAt: '2026-09-02T12:00:01.000Z' },
        '2026-09-02T12:00:00.000Z',
      ),
    ).toBe(true);
  });

  it('rejects cache when this sitting has no openAt', () => {
    expect(
      cacheLooksLikeCurrentSession(
        { createdAt: '2026-09-02T12:00:01.000Z' },
        null,
      ),
    ).toBe(false);
  });

  it('rejects cache when timestamps cannot be parsed', () => {
    expect(
      cacheLooksLikeCurrentSession(
        { createdAt: 'not-a-date' },
        '2026-09-02T12:00:00.000Z',
      ),
    ).toBe(false);
  });
});
