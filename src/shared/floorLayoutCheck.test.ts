import { describe, expect, it } from 'vitest';
import { floorLayoutProblem } from './floorLayoutCheck';

describe('floorLayoutProblem', () => {
  it('accepts a normal layout, shapes and areas included', () => {
    expect(
      floorLayoutProblem([
        { kind: 'TABLE', label: 'G1', seats: 2 },
        { kind: 'TABLE', label: 'G2' },
        { kind: 'AREA', label: '' },
        { kind: 'AREA', label: 'Bar' },
      ]),
    ).toBeNull();
  });

  it('refuses 0, negative and fractional seats', () => {
    for (const seats of [0, -3, 1.5, 'abc']) {
      expect(floorLayoutProblem([{ label: 'G1', seats }])).toMatchObject({
        code: 'BAD_SEATS',
        label: 'G1',
      });
    }
  });

  it('refuses two tables with the same name in one area', () => {
    expect(
      floorLayoutProblem([
        { kind: 'TABLE', label: 'G5', seats: 2 },
        { kind: 'TABLE', label: 'g5 ', seats: 4 },
      ]),
    ).toEqual({ code: 'DUPLICATE_LABEL', label: 'g5' });
  });

  it('refuses a table without a name', () => {
    expect(floorLayoutProblem([{ kind: 'TABLE', label: ' ' }])).toEqual({
      code: 'NO_LABEL',
      index: 0,
    });
  });
});
