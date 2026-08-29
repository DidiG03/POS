import { prisma } from '@db/client';
import { sanitizeMergeGroups, type TableMergeGroup } from '@shared/tableMerge';
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

export async function writeTableMerges(
  area: string,
  groups: unknown,
): Promise<TableMergeGroup[]> {
  const a = String(area || '').trim();
  if (!a) return [];
  const next = sanitizeMergeGroups(groups);
  await prisma.syncState.upsert({
    where: { key: tableMergesKey(a) },
    create: { key: tableMergesKey(a), valueJson: { groups: next } },
    update: { valueJson: { groups: next } },
  });
  try {
    broadcastTableMergesChanged({ area: a });
  } catch {
    // best-effort
  }
  return next;
}
