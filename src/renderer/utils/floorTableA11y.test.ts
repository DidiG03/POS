import { describe, expect, it } from 'vitest';
import { floorTableA11yName } from './floorTableA11y';

describe('floorTableA11yName', () => {
  it('names a free table', () => {
    expect(
      floorTableA11yName({
        label: 'T7',
        occupied: false,
        openLabel: 'OPEN',
        freeLabel: 'FREE',
      }),
    ).toBe('T7, FREE');
  });

  it('includes occupancy and a badge or seats', () => {
    expect(
      floorTableA11yName({
        label: 'T7',
        occupied: true,
        openLabel: 'OPEN',
        freeLabel: 'FREE',
        detail: 'D',
      }),
    ).toBe('T7, OPEN, D');
    expect(
      floorTableA11yName({
        label: 'T1',
        occupied: false,
        openLabel: 'OPEN',
        freeLabel: 'FREE',
        detail: ' • seats 4',
      }),
    ).toBe('T1, FREE, seats 4');
  });
});
