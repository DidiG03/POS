export type LoginDirectoryUser = {
  id: number;
  displayName: string;
  role?: string;
  active?: boolean;
};

/**
 * POS login hides admins (they sign in via OneTap Admin). An install that
 * only has that first admin must not be treated as "no users yet" or the
 * till asks to create a second bootstrap admin against a live database.
 */
export function loginDirectoryState(
  users: LoginDirectoryUser[] | null | undefined,
  isAdminContext: boolean,
): {
  directoryEmpty: boolean;
  staff: LoginDirectoryUser[];
} {
  const all = Array.isArray(users) ? users : [];
  const staff = isAdminContext
    ? all.filter((u) => u.role === 'ADMIN' && u.active !== false)
    : all.filter((u) => {
        const role = String(u.role || '').toUpperCase();
        return u.active !== false && role !== 'ADMIN' && role !== 'HOST';
      });
  return { directoryEmpty: all.length === 0, staff };
}
