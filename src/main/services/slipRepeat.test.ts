import { describe, expect, it } from 'vitest';
import { findRepeatedSlip } from './slipRepeat';

const NOW = 1_790_000_000_000;
const slip = (extra: any = {}) => ({
  area: 'Main',
  tableLabel: 'T2',
  items: [{ sku: 'BEER', name: 'Beer', qty: 2 }],
  meta: { kind: 'ORDER', ...extra },
});

describe('findRepeatedSlip', () => {
  it('finds the same Send printed before', () => {
    const at = new Date(NOW - 60 * 60_000);
    expect(
      findRepeatedSlip(
        slip({ sendKey: 's1' }),
        [{ createdAt: at, payloadJson: slip({ sendKey: 's1' }) }],
        NOW,
      ),
    ).toBe(at);
  });
  it('a new Send with the same lines is a new order, not a copy', () => {
    expect(
      findRepeatedSlip(
        slip({ sendKey: 's2' }),
        [
          {
            createdAt: new Date(NOW - 60_000),
            payloadJson: slip({ sendKey: 's1' }),
          },
        ],
        NOW,
      ),
    ).toBeNull();
  });
  it('without a Send key, the same lines within minutes are a copy', () => {
    const at = new Date(NOW - 2 * 60_000);
    expect(
      findRepeatedSlip(slip(), [{ createdAt: at, payloadJson: slip() }], NOW),
    ).toBe(at);
    expect(
      findRepeatedSlip(
        slip(),
        [{ createdAt: new Date(NOW - 30 * 60_000), payloadJson: slip() }],
        NOW,
      ),
    ).toBeNull();
  });
  it('ignores other tables and void slips', () => {
    expect(
      findRepeatedSlip(
        slip(),
        [
          {
            createdAt: new Date(NOW - 60_000),
            payloadJson: { ...slip(), tableLabel: 'T3' },
          },
          {
            createdAt: new Date(NOW - 60_000),
            payloadJson: slip({ voidSlip: 'ITEM' }),
          },
        ],
        NOW,
      ),
    ).toBeNull();
  });
});
