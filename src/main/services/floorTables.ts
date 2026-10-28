/**
 * Which area/table pairs exist, for the routes that write to a table.
 *
 * The till took any area and table name a device sent: a phone could open
 * "Nowhere"/X1, send an order to A/S1, or transfer a bill to a made-up
 * table, after which the bill sat on a table no floor plan draws and the
 * waiter could not find it again.
 *
 * A table exists when it is on the area's saved floor layout, or — before
 * the admin has drawn one — when it is one of the area's default T1..Tn,
 * the same tables the floor screens draw. A table that is open right now
 * also counts, so removing a table from the layout mid-service never
 * strands the bill on it. The shop counter area is not a floor table and
 * is always allowed.
 */
import { prisma } from '@db/client';
import { isStoreCounterArea } from '@shared/editionCapabilities';
import { coreServices } from './core';
import { tableAreasFromDb } from './tableAreasSync';

const MAX_DEFAULT_TABLES = 200;

function layoutTableLabels(nodes: unknown): string[] | null {
  if (!Array.isArray(nodes)) return null;
  const out: string[] = [];
  for (const n of nodes as any[]) {
    const kind = String(n?.kind || '').toUpperCase();
    if (kind && kind !== 'TABLE') continue;
    const label = String(n?.label || '').trim();
    if (label) out.push(label);
  }
  return out;
}

/** Saved layout tables for `area`, or `null` when no layout is saved. */
async function savedLayoutLabels(area: string): Promise<string[] | null> {
  const row = await prisma.syncState
    .findUnique({ where: { key: `layout:global:${area}` } })
    .catch(() => null);
  const labels = layoutTableLabels((row?.valueJson as any)?.nodes);
  // An empty saved layout draws the default tables on the floor screens.
  return labels && labels.length ? labels : null;
}

export type FloorTableCheck =
  | { ok: true }
  | { ok: false; code: 'UNKNOWN_AREA' | 'UNKNOWN_TABLE'; error: string };

/** Pure core: is `label` one of `area`'s tables? */
export function tableInFloor(input: {
  label: string;
  layoutLabels: string[] | null;
  defaultCount: number;
}): boolean {
  const label = String(input.label || '').trim();
  if (!label) return false;
  if (input.layoutLabels) return input.layoutLabels.includes(label);
  const n = Math.max(
    1,
    Math.min(MAX_DEFAULT_TABLES, Math.floor(Number(input.defaultCount) || 8)),
  );
  const m = /^T(\d+)$/.exec(label);
  return Boolean(m && Number(m[1]) >= 1 && Number(m[1]) <= n);
}

/**
 * Check that `area`/`tableLabel` exist. Open tables always pass (see the
 * module note).
 */
export async function checkFloorTable(
  area: string,
  tableLabel: string,
): Promise<FloorTableCheck> {
  const a = String(area || '').trim();
  const label = String(tableLabel || '').trim();
  if (isStoreCounterArea(a)) return { ok: true };
  if (await coreServices.isTableOpen(a, label).catch(() => false)) {
    return { ok: true };
  }
  const settings = await coreServices.readSettings().catch(() => ({}));
  const areas = await tableAreasFromDb((settings as any)?.tableAreas).catch(
    () => [],
  );
  // No areas configured at all (fresh install, or a store till): nothing
  // to check against.
  if (!areas.length) return { ok: true };
  const configured = areas.find((x) => x.name === a);
  if (!configured) {
    return {
      ok: false,
      code: 'UNKNOWN_AREA',
      error: `There is no area called "${a}". Refresh the floor plan and pick a table again.`,
    };
  }
  const layoutLabels = await savedLayoutLabels(a);
  if (
    !tableInFloor({
      label,
      layoutLabels,
      defaultCount: configured.count,
    })
  ) {
    return {
      ok: false,
      code: 'UNKNOWN_TABLE',
      error: `There is no table "${label}" in ${a}. Refresh the floor plan and pick a table again.`,
    };
  }
  return { ok: true };
}
