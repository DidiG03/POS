import { describe, expect, it } from 'vitest';
import {
  bumpReadyKitchenItems,
  cookerBumpAllKitchenItems,
  cookerBumpSingleKitchenItem,
  isItemLockedForMain,
  isTwoStageKitchen,
  viewKitchenItemsForCooker,
} from './kdsCooker';

const at = '2026-06-06T20:00:00.000Z';

function kitchen(name: string, extra: Record<string, unknown> = {}) {
  return { name, station: 'KITCHEN', qty: 1, ...extra };
}
function bar(name: string, extra: Record<string, unknown> = {}) {
  return { name, station: 'BAR', qty: 1, ...extra };
}

describe('isTwoStageKitchen', () => {
  it('is true only for KITCHEN when cooker mode is enabled', () => {
    expect(isTwoStageKitchen('KITCHEN', true)).toBe(true);
    expect(isTwoStageKitchen('kitchen', true)).toBe(true);
    expect(isTwoStageKitchen('KITCHEN', false)).toBe(false);
    expect(isTwoStageKitchen('BAR', true)).toBe(false);
    expect(isTwoStageKitchen('DESSERT', true)).toBe(false);
  });
});

describe('cooker bumps', () => {
  it('cookerBumpAllKitchenItems only touches active kitchen items', () => {
    const items = [
      kitchen('Steak'),
      kitchen('Fries', { voided: true }),
      kitchen('Soup', { cookerBumped: true }),
      bar('Coke'),
    ];
    const out = cookerBumpAllKitchenItems(items, at);
    expect(out[0]).toMatchObject({ cookerBumped: true, cookerBumpedAt: at });
    expect(out[1].cookerBumped).toBeUndefined(); // voided untouched
    expect(out[2].cookerBumped).toBe(true); // already cooked, unchanged
    expect(out[3].cookerBumped).toBeUndefined(); // bar untouched
  });

  it('cookerBumpSingleKitchenItem marks just one line', () => {
    const items = [kitchen('Steak'), kitchen('Soup')];
    const out = cookerBumpSingleKitchenItem(items, 1, at);
    expect(out[0].cookerBumped).toBeUndefined();
    expect(out[1]).toMatchObject({ cookerBumped: true, cookerBumpedAt: at });
  });

  it('cookerBumpSingleKitchenItem ignores a bar line', () => {
    const items = [bar('Coke')];
    expect(cookerBumpSingleKitchenItem(items, 0, at)[0].cookerBumped).toBe(
      undefined,
    );
  });
});

describe('bumpReadyKitchenItems (main whole-ticket bump)', () => {
  it('finalises only cooked lines, leaves locked ones', () => {
    const items = [
      kitchen('Steak', { cookerBumped: true }),
      kitchen('Soup'), // not cooked yet → stays locked
    ];
    const out = bumpReadyKitchenItems(items, at);
    expect(out[0]).toMatchObject({ bumped: true });
    expect(out[1].bumped).toBeUndefined();
  });
});

describe('isItemLockedForMain', () => {
  it('locks un-cooked, active kitchen lines', () => {
    expect(isItemLockedForMain(kitchen('Soup'))).toBe(true);
    expect(isItemLockedForMain(kitchen('Soup', { cookerBumped: true }))).toBe(
      false,
    );
    expect(isItemLockedForMain(kitchen('Soup', { bumped: true }))).toBe(false);
    expect(isItemLockedForMain(kitchen('Soup', { voided: true }))).toBe(false);
  });
});

describe('viewKitchenItemsForCooker', () => {
  const items = [
    kitchen('Steak', { _idx: 0 }), // raw
    kitchen('Soup', { _idx: 1, cookerBumped: true }), // cooked, not picked up
    kitchen('Salad', { _idx: 2, cookerBumped: true, bumped: true }), // done
    kitchen('Fries', { _idx: 3, voided: true }),
  ];

  it('cooker NEW shows only un-cooked lines', () => {
    const out = viewKitchenItemsForCooker(items, { cooker: true, tab: 'NEW' });
    expect(out.map((i) => i.name)).toEqual(['Steak']);
  });

  it('cooker DONE shows cooked-but-not-picked-up lines', () => {
    const out = viewKitchenItemsForCooker(items, { cooker: true, tab: 'DONE' });
    expect(out.map((i) => i.name)).toEqual(['Soup']);
  });

  it('main NEW shows active lines with locked/ready flags', () => {
    const out = viewKitchenItemsForCooker(items, { cooker: false, tab: 'NEW' });
    expect(out.map((i) => i.name)).toEqual(['Steak', 'Soup']);
    expect(out[0]).toMatchObject({ locked: true, ready: false });
    expect(out[1]).toMatchObject({ locked: false, ready: true });
  });
});
