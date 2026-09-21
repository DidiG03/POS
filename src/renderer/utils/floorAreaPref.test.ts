import { describe, expect, it } from 'vitest';
import { resolveInitialFloorArea } from './floorAreaPref';

const areas = [
  { name: 'Salla', count: 10 },
  { name: 'Ballkoni', count: 6 },
  { name: 'Tarraca', count: 8 },
];

describe('resolveInitialFloorArea', () => {
  it('prefers the URL area when it is configured', () => {
    expect(
      resolveInitialFloorArea({
        areas,
        urlArea: 'Tarraca',
        storedArea: 'Ballkoni',
        selectedTableArea: 'Salla',
      }),
    ).toBe('Tarraca');
  });

  it('uses the last chip choice when the URL is empty', () => {
    expect(
      resolveInitialFloorArea({
        areas,
        urlArea: '',
        storedArea: 'Ballkoni',
        selectedTableArea: 'Salla',
      }),
    ).toBe('Ballkoni');
  });

  it('falls back to the table the waiter was just on', () => {
    expect(
      resolveInitialFloorArea({
        areas,
        urlArea: '',
        storedArea: '',
        selectedTableArea: 'Tarraca',
      }),
    ).toBe('Tarraca');
  });

  it('does not keep a removed area', () => {
    expect(
      resolveInitialFloorArea({
        areas,
        urlArea: 'Patio',
        storedArea: 'Patio',
        selectedTableArea: 'Patio',
      }),
    ).toBe('Salla');
  });
});
