import { beforeEach, describe, expect, it, vi } from 'vitest';

const { users } = vi.hoisted(() => ({
  users: [] as Array<{ id: number; role: string; active: boolean }>,
}));

vi.mock('@db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(
        async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
      ),
      count: vi.fn(
        async ({ where }: any) =>
          users.filter(
            (u) =>
              u.role === where.role &&
              u.active === where.active &&
              u.id !== where.id.not,
          ).length,
      ),
    },
  },
}));

import { wouldRemoveLastActiveAdmin } from './lastAdmin';

beforeEach(() => {
  users.length = 0;
  users.push(
    { id: 1, role: 'ADMIN', active: true },
    { id: 2, role: 'WAITER', active: true },
  );
});

describe('wouldRemoveLastActiveAdmin', () => {
  it('refuses disabling or demoting the only active admin', async () => {
    expect(await wouldRemoveLastActiveAdmin(1, { active: false })).toBe(true);
    expect(await wouldRemoveLastActiveAdmin(1, { role: 'WAITER' })).toBe(true);
  });

  it('allows it once another active admin exists', async () => {
    users.push({ id: 3, role: 'ADMIN', active: true });
    expect(await wouldRemoveLastActiveAdmin(1, { active: false })).toBe(false);
  });

  it('ignores changes that keep the admin, and other staff', async () => {
    expect(await wouldRemoveLastActiveAdmin(1, { role: 'ADMIN' })).toBe(false);
    expect(await wouldRemoveLastActiveAdmin(1, { active: true })).toBe(false);
    expect(await wouldRemoveLastActiveAdmin(2, { active: false })).toBe(false);
  });
});
