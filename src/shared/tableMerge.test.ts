import { describe, expect, it } from 'vitest';
import {
  clientToFloorLayout,
  formatMergeLabel,
  mergeMembersFor,
  mergeTableGroups,
  pruneMergeGroups,
  sanitizeMergeGroups,
  separateTableGroup,
  tablesTouching,
} from './tableMerge';

describe('sanitizeMergeGroups', () => {
  it('drops groups with fewer than two tables and overlapping members', () => {
    expect(
      sanitizeMergeGroups([
        { id: 'a', labels: ['T1'], x: 0, y: 0 },
        { id: 'b', labels: ['T2', 'T1'], x: 1, y: 1 },
        { id: 'c', labels: ['T3', 'T4'], x: 2, y: 2 },
        { id: 'd', labels: ['T4', 'T5'], x: 3, y: 3 },
      ]),
    ).toEqual([
      { id: 'b', labels: ['T1', 'T2'], x: 1, y: 1 },
      { id: 'c', labels: ['T3', 'T4'], x: 2, y: 2 },
    ]);
  });
});

describe('mergeTableGroups', () => {
  it('joins two free pairs into one group at the drop point', () => {
    const next = mergeTableGroups(
      [{ id: 'g', labels: ['T1', 'T2'], x: 10, y: 10 }],
      ['T1', 'T2'],
      ['T3'],
      40,
      50,
    );
    expect(next).toHaveLength(1);
    expect(next[0].labels).toEqual(['T1', 'T2', 'T3']);
    expect(next[0].x).toBe(40);
    expect(next[0].y).toBe(50);
  });
});

describe('separateTableGroup', () => {
  it('removes only the matching merge', () => {
    const groups = [
      { id: 'a', labels: ['T1', 'T2'], x: 0, y: 0 },
      { id: 'b', labels: ['T3', 'T4'], x: 1, y: 1 },
    ];
    expect(separateTableGroup(groups, 'T2')).toEqual([
      { id: 'b', labels: ['T3', 'T4'], x: 1, y: 1 },
    ]);
  });
});

describe('formatMergeLabel', () => {
  it('joins sorted labels', () => {
    expect(formatMergeLabel(['T12', 'T2'])).toBe('T2+T12');
  });
});

describe('pruneMergeGroups', () => {
  it('drops members that are no longer on the floor', () => {
    expect(
      pruneMergeGroups(
        [
          { id: 'a', labels: ['T1', 'T2', 'T9'], x: 0, y: 0 },
          { id: 'b', labels: ['T3', 'T4'], x: 1, y: 1 },
        ],
        ['T1', 'T2', 'T3'],
      ),
    ).toEqual([{ id: 'a', labels: ['T1', 'T2'], x: 0, y: 0 }]);
  });
});

describe('mergeMembersFor', () => {
  it('returns the whole group or the single label', () => {
    const groups = [{ id: 'a', labels: ['T1', 'T2'], x: 0, y: 0 }];
    expect(mergeMembersFor(groups, 'T2')).toEqual(['T1', 'T2']);
    expect(mergeMembersFor(groups, 'T9')).toEqual(['T9']);
  });
});

describe('tablesTouching', () => {
  it('treats nearby 64px tables as overlapping', () => {
    expect(
      tablesTouching(
        { x: 100, y: 100, w: 64, h: 64 },
        { x: 130, y: 100, w: 64, h: 64 },
      ),
    ).toBe(true);
    expect(
      tablesTouching(
        { x: 100, y: 100, w: 64, h: 64 },
        { x: 220, y: 100, w: 64, h: 64 },
      ),
    ).toBe(false);
  });
});

describe('clientToFloorLayout', () => {
  it('inverts auto-fit translate + scale so a table stays under the finger', () => {
    const outer = { left: 10, top: 20 };
    const zoom = { scale: 1, tx: 0, ty: 0 };
    const view = { scaleX: 2, scaleY: 1.5, tx: 30, ty: 40 };
    const layoutX = 100;
    const layoutY = 50;
    const clientX =
      outer.left + zoom.tx + zoom.scale * (view.tx + view.scaleX * layoutX);
    const clientY =
      outer.top + zoom.ty + zoom.scale * (view.ty + view.scaleY * layoutY);
    expect(clientToFloorLayout(clientX, clientY, outer, zoom, view)).toEqual({
      x: layoutX,
      y: layoutY,
    });
  });

  it('inverts pinch-zoom on top of auto-fit', () => {
    const outer = { left: 0, top: 0 };
    const zoom = { scale: 2, tx: 8, ty: -4 };
    const view = { scaleX: 1.2, scaleY: 1.2, tx: 15, ty: 25 };
    const p = { x: 80, y: 60 };
    const clientX =
      outer.left + zoom.tx + zoom.scale * (view.tx + view.scaleX * p.x);
    const clientY =
      outer.top + zoom.ty + zoom.scale * (view.ty + view.scaleY * p.y);
    const out = clientToFloorLayout(clientX, clientY, outer, zoom, view);
    expect(out.x).toBeCloseTo(p.x);
    expect(out.y).toBeCloseTo(p.y);
  });
});
