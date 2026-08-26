import { describe, expect, it } from 'vitest';
import { pickConfiguredArea, saneTableAreas } from './tableAreas';

describe('saneTableAreas', () => {
  it('drops empty names and fills a missing count', () => {
    expect(
      saneTableAreas([
        { name: '  Salla Brenda ', count: 12 },
        { name: '', count: 4 },
        { name: 'Ballkoni' },
      ]),
    ).toEqual([
      { name: 'Salla Brenda', count: 12 },
      { name: 'Ballkoni', count: 8 },
    ]);
  });

  it('returns [] for garbage so the UI does not invent Main Hall', () => {
    expect(saneTableAreas(null)).toEqual([]);
    expect(saneTableAreas({ name: 'Main Hall' })).toEqual([]);
  });
});

describe('pickConfiguredArea', () => {
  const areas = [
    { name: 'Salla Brenda', count: 10 },
    { name: 'Ballkoni', count: 6 },
  ];

  it('keeps the current area when it is still configured', () => {
    expect(pickConfiguredArea('Ballkoni', areas)).toBe('Ballkoni');
  });

  it('falls back to the first admin area instead of a hardcoded Main Hall', () => {
    expect(pickConfiguredArea('Main Hall', areas)).toBe('Salla Brenda');
    expect(pickConfiguredArea('', areas)).toBe('Salla Brenda');
  });

  it('clears the selection when no areas are configured', () => {
    expect(pickConfiguredArea('Main Hall', [])).toBe('');
  });
});
