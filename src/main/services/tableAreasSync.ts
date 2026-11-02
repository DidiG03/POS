import { prisma } from '@db/client';
import { saneTableAreas, type TableArea } from '@shared/tableAreas';

export async function tableAreasFromDb(
  fallback: unknown,
): Promise<TableArea[]> {
  const dbAreas: { name: string; defaultCount: number }[] = await prisma.area
    .findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } })
    .catch(() => []);
  if (dbAreas.length) {
    return dbAreas.map((a) => ({ name: a.name, count: a.defaultCount }));
  }
  return saneTableAreas(fallback);
}

/** Mirror Settings.tableAreas into the Area table so GET /settings
 *  (which prefers live Area rows) matches what Admin just saved. */
export async function syncTableAreasToDb(raw: unknown): Promise<void> {
  const areas = saneTableAreas(raw);
  // Never a bulk delete: an empty (or all-unnamed) list used to deactivate
  // every area on the floor (QA v0.2.103, #7). Saves are validated first
  // (`tableAreasProblem`); this guard holds for anything that gets past.
  if (areas.length === 0) {
    console.warn('[areas] ignored a save with no named area');
    return;
  }
  for (let i = 0; i < areas.length; i++) {
    const a = areas[i];
    await prisma.area.upsert({
      where: { name: a.name },
      create: { name: a.name, defaultCount: a.count, sortOrder: i },
      update: { defaultCount: a.count, sortOrder: i, active: true },
    });
  }
  const names = areas.map((a) => a.name);
  await prisma.area.updateMany({
    where: { name: { notIn: names } },
    data: { active: false },
  });
}
