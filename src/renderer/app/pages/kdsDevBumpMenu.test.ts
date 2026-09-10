import { describe, expect, it } from 'vitest';
import { clampKdsDevMenuPos, kdsItemIsBumpable } from './kdsDevBumpMenu';

describe('kdsItemIsBumpable', () => {
  it('allows an active kitchen line', () => {
    expect(kdsItemIsBumpable({ name: 'Steak' }, false)).toBe(true);
  });

  it('blocks voided, locked, and already bumped lines', () => {
    expect(kdsItemIsBumpable({ name: 'Steak', voided: true }, false)).toBe(
      false,
    );
    expect(kdsItemIsBumpable({ name: 'Steak', locked: true }, false)).toBe(
      false,
    );
    expect(kdsItemIsBumpable({ name: 'Steak', bumped: true }, false)).toBe(
      false,
    );
  });

  it('on the cooker screen, blocks lines the cook already bumped', () => {
    expect(kdsItemIsBumpable({ name: 'Steak', cookerBumped: true }, true)).toBe(
      false,
    );
    expect(kdsItemIsBumpable({ name: 'Steak' }, true)).toBe(true);
  });
});

describe('clampKdsDevMenuPos', () => {
  it('keeps the menu inside the viewport', () => {
    expect(
      clampKdsDevMenuPos(390, 290, 220, 132, { width: 400, height: 300 }),
    ).toEqual({ x: 172, y: 160 });
  });
});
