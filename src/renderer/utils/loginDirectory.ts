export type LoginDirectoryUser = {
  id: number;
  displayName: string;
  role?: string;
  active?: boolean;
};

/**
 * POS login hides admins (they sign in via OneTap Admin). After a license
 * key, the till must land on Select Staff and wait — never the bootstrap
 * admin form. Only the Admin companion may create the first user.
 */
export function loginDirectoryState(
  users: LoginDirectoryUser[] | null | undefined,
  isAdminContext: boolean,
): {
  needsFirstAdmin: boolean;
  emptyDatabase: boolean;
  staff: LoginDirectoryUser[];
} {
  const all = Array.isArray(users) ? users : [];
  const staff = isAdminContext
    ? all.filter((u) => u.role === 'ADMIN' && u.active !== false)
    : all.filter((u) => {
        const role = String(u.role || '').toUpperCase();
        return u.active !== false && role !== 'ADMIN' && role !== 'HOST';
      });
  return {
    needsFirstAdmin: isAdminContext && all.length === 0,
    emptyDatabase: all.length === 0,
    staff,
  };
}
