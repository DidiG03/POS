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
    expect(pos.needsFirstAdmin).toBe(false);
    expect(pos.staff).toEqual([]);
    const adminApp = loginDirectoryState([admin], true);
    expect(adminApp.staff.map((u) => u.id)).toEqual([1]);
  });

  it('never offers first-admin setup on POS, even with an empty database', () => {
    expect(loginDirectoryState([], false).needsFirstAdmin).toBe(false);
    expect(loginDirectoryState([], true).needsFirstAdmin).toBe(true);
    expect(loginDirectoryState([admin, waiter], false).staff).toEqual([waiter]);
  });
});
