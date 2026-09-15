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
