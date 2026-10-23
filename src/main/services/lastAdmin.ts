/**
 * Keep at least one active admin.
 *
 * Deleting the last admin was refused, but disabling or demoting them was
 * not — and with staff still on file the first-admin setup never comes back,
 * so the till was left with no way into Admin at all.
 */
import { prisma } from '@db/client';

export const LAST_ADMIN_ERROR =
  'This is the only active admin. Add another admin before disabling or demoting this one.';

export async function wouldRemoveLastActiveAdmin(
  id: number,
  change: { active?: boolean; role?: string | null },
): Promise<boolean> {
  const demotes =
    change.role != null && String(change.role).toUpperCase() !== 'ADMIN';
  if (change.active !== false && !demotes) return false;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { role: true, active: true },
  });
  if (!user || String(user.role).toUpperCase() !== 'ADMIN' || !user.active) {
    return false;
  }
  const others = await prisma.user.count({
    where: { role: 'ADMIN' as any, active: true, id: { not: id } } as any,
  });
  return others <= 0;
}
