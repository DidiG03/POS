import { describe, expect, it } from 'vitest';
import { loginDirectoryState } from './loginDirectory';

const admin = {
  id: 1,
  displayName: 'Sefrid',
  role: 'ADMIN',
  active: true,
};
const waiter = {
  id: 2,
  displayName: 'Ana',
  role: 'WAITER',
  active: true,
};

describe('loginDirectoryState', () => {
  it('treats a POS with only an admin as set up, not first-run', () => {
    const pos = loginDirectoryState([admin], false);
    expect(pos.directoryEmpty).toBe(false);
    expect(pos.staff).toEqual([]);
    const adminApp = loginDirectoryState([admin], true);
    expect(adminApp.staff.map((u) => u.id)).toEqual([1]);
  });

  it('only offers first-admin setup when the database has no users', () => {
    expect(loginDirectoryState([], false).directoryEmpty).toBe(true);
    expect(loginDirectoryState([admin, waiter], false).staff).toEqual([waiter]);
  });
});
