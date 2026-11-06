import { prisma } from '@db/client';
import { KeyedAsyncMutex } from '@shared/asyncMutex';
import {
  rebaseMergeEdit,
  sanitizeMergeGroups,
  type TableMergeGroup,
} from '@shared/tableMerge';
import { broadcastTableMergesChanged } from './realtime';

export function tableMergesKey(area: string): string {
  return `tableMerges:global:${String(area)}`;
}

export async function readTableMerges(
  area: string,
): Promise<TableMergeGroup[]> {
  const a = String(area || '').trim();
  if (!a) return [];
  const row = await prisma.syncState
    .findUnique({ where: { key: tableMergesKey(a) } })
    .catch(() => null);
  return sanitizeMergeGroups((row?.valueJson as any)?.groups);
}

/** One merge save per area at a time: read, apply the edit, write. */
const areaLocks = new KeyedAsyncMutex();

/**
 * Save an area's merges. With `base` (the list the device started from)
 * only that device's edit is applied onto what is saved now
 * (`rebaseMergeEdit`), so concurrent saves no longer overwrite each other.
 * Without it (an app older than 0.2.109) the list replaces the saved one,
 * as before.
 */
export async function writeTableMerges(
  area: string,
  groups: unknown,
  base?: unknown,
): Promise<TableMergeGroup[]> {
  const a = String(area || '').trim();
  if (!a) return [];
  const next = await areaLocks.runExclusive(a, async () => {
    const value = Array.isArray(base)
      ? rebaseMergeEdit(await readTableMerges(a), base, groups)
      : sanitizeMergeGroups(groups);
    await prisma.syncState.upsert({
      where: { key: tableMergesKey(a) },
      create: { key: tableMergesKey(a), valueJson: { groups: value } },
      update: { valueJson: { groups: value } },
    });
    return value;
  });
  try {
    broadcastTableMergesChanged({ area: a });
  } catch {
    // best-effort
  }
  return next;
}
