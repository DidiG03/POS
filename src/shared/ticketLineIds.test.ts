import { describe, expect, it } from 'vitest';
import { findLineIndexById, withLineIds } from './ticketLineIds';

describe('withLineIds', () => {
  it('derives ids for a bill written before line ids, the same every read', () => {
    const items: Array<{ name: string; lineId?: string }> = [
      { name: 'A' },
      { name: 'B' },
    ];
    expect(withLineIds(items, { seed: 12 }).map((l) => l.lineId)).toEqual([
      'L12.0',
      'L12.1',
    ]);
    expect(withLineIds(items, { seed: 12 })).toEqual(
      withLineIds(items, { seed: 12 }),
    );
  });

  it('keeps ids, and re-ids a repeated one', () => {
    let n = 0;
    const out = withLineIds(
      [{ name: 'A', lineId: 'x' }, { name: 'A', lineId: 'x' }, { name: 'B' }],
      { newId: () => `new-${++n}` },
    );
    expect(out.map((l) => l.lineId)).toEqual(['x', 'new-1', 'new-2']);
  });

  it('returns the same array when every line has a unique id', () => {
    const items = [{ lineId: 'a' }, { lineId: 'b' }];
    expect(withLineIds(items)).toBe(items);
    expect(findLineIndexById(items, 'b')).toBe(1);
    expect(findLineIndexById(items, '')).toBe(-1);
  });
});
