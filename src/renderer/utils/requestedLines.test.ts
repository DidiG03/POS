import { describe, expect, it } from 'vitest';
import { requestedLinesState } from './requestedLines';

describe('requested lines on the requester phone (QA round 6, #6)', () => {
  it('a line in a pending request keeps the button locked', () => {
    const s = requestedLinesState(
      ['a', 'b'],
      [{ id: 1, status: 'PENDING', lineIds: ['a', 'b'] }],
    );
    expect([...s.pending]).toEqual(['a', 'b']);
    expect(s.decided.size).toBe(0);
  });

  it('approved (or already applied) lines leave the phone', () => {
    const s = requestedLinesState(
      ['a', 'b'],
      [
        { id: 2, status: 'APPLIED', lineIds: ['b'] },
        { id: 1, status: 'APPROVED', lineIds: ['a'] },
      ],
    );
    expect(s.pending.size).toBe(0);
    expect(Object.fromEntries(s.decided)).toEqual({
      a: 'APPROVED',
      b: 'APPROVED',
    });
  });

  it('rejected lines leave too, so they are not asked for again by accident', () => {
    const s = requestedLinesState(
      ['a'],
      [{ id: 1, status: 'REJECTED', lineIds: ['a'] }],
    );
    expect(s.decided.get('a')).toBe('REJECTED');
  });

  it('a line never requested is neither (the waiter can still request it)', () => {
    const s = requestedLinesState(
      ['new'],
      [{ id: 1, status: 'APPROVED', lineIds: ['a'] }],
    );
    expect(s.pending.size).toBe(0);
    expect(s.decided.size).toBe(0);
  });

  it('the newest request for a line decides', () => {
    const s = requestedLinesState(
      ['a'],
      [
        { id: 3, status: 'PENDING', lineIds: ['a'] },
        { id: 1, status: 'REJECTED', lineIds: ['a'] },
      ],
    );
    expect(s.pending.has('a')).toBe(true);
  });
});
