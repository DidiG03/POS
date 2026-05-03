/**
 * Cloud sync: fetch users and menu from cloud backend and upsert into local DB.
 * Used when user logs in to cloud - syncs their business data for local-first use.
 */
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';
import {
  getCloudConfig,
  getCloudAccessPassword,
  getCloudToken,
  cloudJson,
} from './cloud.js';

const DEFAULT_SYNCED_PIN = '1234';
const CLOUD_CAT_MAP_KEY = 'cloud:categoryMap';

type CloudUser = { id: number; displayName: string; role: string; active: boolean };
type CloudCategory = {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  items: CloudMenuItem[];
};
type CloudMenuItem = {
  id: number;
  name: string;
  sku: string;
  price: number;
  vatRate: number;
  active: boolean;
  categoryId: number;
  isKg?: boolean;
};

export type SyncUsersResult = { count: number; error?: string };

/**
 * Sync users from cloud (public-users) into local DB.
 * No auth token needed - uses businessCode + accessPassword.
 * Creates users with default PIN; caller should update the logging-in user's PIN.
 * Returns { count, error? } so callers can distinguish empty cloud from sync failure.
 */
export async function syncUsersFromCloud(): Promise<SyncUsersResult> {
  const cfg = await getCloudConfig();
  if (!cfg) return { count: 0, error: 'Cloud not configured' };

  const accessPassword = await getCloudAccessPassword();
  const url = `${cfg.backendUrl}/auth/public-users?businessCode=${encodeURIComponent(cfg.businessCode)}&includeAdmins=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: accessPassword ? { 'x-business-password': accessPassword } : undefined,
    });
  } catch (e: any) {
    return { count: 0, error: e?.message || 'Network error' };
  }

  if (!res.ok) {
    const msg = res.status === 401 || res.status === 403
      ? 'Check business code and access password in Settings → Log in to Cloud'
      : res.statusText || `HTTP ${res.status}`;
    return { count: 0, error: msg };
  }

  let users: CloudUser[];
  try {
    users = await res.json();
  } catch {
    return { count: 0, error: 'Invalid response from cloud' };
  }
  if (!Array.isArray(users) || users.length === 0) return { count: 0 };

  const defaultPinHash = await bcrypt.hash(DEFAULT_SYNCED_PIN, 10);
  let count = 0;

  for (const u of users) {
    const externalId = String(u.id);
    const existing = await prisma.user.findFirst({ where: { externalId } });
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          displayName: u.displayName,
          role: u.role as any,
          active: u.active,
        },
      });
      count++;
    } else {
      await prisma.user.create({
        data: {
          displayName: u.displayName,
          role: u.role as any,
          pinHash: defaultPinHash,
          active: u.active,
          externalId,
        } as any,
      });
      count++;
    }
  }
  return { count };
}

/**
 * Update a synced user's PIN after successful cloud login.
 */
export async function updateSyncedUserPin(
  cloudUserId: number,
  verifiedPin: string
): Promise<boolean> {
  const externalId = String(cloudUserId);
  const user = await prisma.user.findFirst({ where: { externalId } });
  if (!user) return false;
  const pinHash = await bcrypt.hash(verifiedPin, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { pinHash },
  });
  return true;
}

/**
 * Sync menu (categories + items) from cloud into local DB.
 * Requires a valid cloud token (from login).
 * Uses SyncState to map cloud category IDs to local.
 */
export async function syncMenuFromCloud(token: string): Promise<number> {
  const cfg = await getCloudConfig();
  if (!cfg) return 0;

  const data = await cloudJson<CloudCategory[]>(
    'GET',
    '/menu/categories',
    undefined,
    {
      requireAuth: true,
      extraHeaders: { Authorization: `Bearer ${token}` },
    }
  ).catch(() => null);

  if (!Array.isArray(data) || data.length === 0) return 0;

  const catMapRow = await prisma.syncState.findUnique({
    where: { key: CLOUD_CAT_MAP_KEY },
  });
  const existingMap: Record<string, number> =
    (catMapRow?.valueJson as Record<string, number>) || {};
  // Rebuild catMap from current cloud response only (avoids stale mappings when categories are deleted)
  const catMap: Record<string, number> = {};
  let itemCount = 0;

  for (const c of data) {
    const cloudCatKey = String(c.id);
    let localCatId = existingMap[cloudCatKey] ?? catMap[cloudCatKey];

    if (localCatId) {
      await prisma.category.update({
        where: { id: localCatId },
        data: {
          name: c.name,
          sortOrder: c.sortOrder ?? 0,
          active: c.active ?? true,
        } as any,
      }).catch(() => null);
    } else {
      const created = await prisma.category.create({
        data: {
          name: c.name,
          sortOrder: c.sortOrder ?? 0,
          active: c.active ?? true,
        } as any,
      });
      localCatId = created.id;
    }
    catMap[cloudCatKey] = localCatId;

    const items = c.items || [];
    for (const i of items) {
      const localCatIdForItem = catMap[String(i.categoryId)] ?? localCatId;
      await prisma.menuItem.upsert({
        where: { sku: i.sku },
        create: {
          name: i.name,
          sku: i.sku,
          categoryId: localCatIdForItem,
          price: i.price,
          vatRate: i.vatRate,
          active: i.active ?? true,
        } as any,
        update: {
          name: i.name,
          categoryId: localCatIdForItem,
          price: i.price,
          vatRate: i.vatRate,
          active: i.active ?? true,
        } as any,
      }).catch(() => null);
      itemCount++;
    }
  }

  await prisma.syncState.upsert({
    where: { key: CLOUD_CAT_MAP_KEY },
    create: { key: CLOUD_CAT_MAP_KEY, valueJson: catMap },
    update: { valueJson: catMap },
  });

  return itemCount;
}

/**
 * Full sync: users (no token) + menu (with token).
 * Call after successful cloud login.
 */
export async function syncFromCloudAfterLogin(
  token: string,
  cloudUserId: number,
  verifiedPin: string
): Promise<{ usersSynced: number; menuItemsSynced: number }> {
  const usersResult = await syncUsersFromCloud();
  const menuItemsSynced = await syncMenuFromCloud(token);
  await updateSyncedUserPin(cloudUserId, verifiedPin);
  return { usersSynced: usersResult.count, menuItemsSynced };
}

/**
 * Manual sync from cloud (e.g. "Sync from cloud" button in Settings).
 * Syncs users always; syncs menu only when cloud session exists.
 */
export async function syncFromCloudManual(): Promise<{
  usersSynced: number;
  menuItemsSynced: number;
  menuSynced: boolean;
  error?: string;
}> {
  const cfg = await getCloudConfig();
  if (!cfg) {
    return { usersSynced: 0, menuItemsSynced: 0, menuSynced: false, error: 'Cloud not configured' };
  }

  const usersResult = await syncUsersFromCloud();
  if (usersResult.error) {
    return {
      usersSynced: 0,
      menuItemsSynced: 0,
      menuSynced: false,
      error: usersResult.error,
    };
  }

  const token = await getCloudToken();
  let menuItemsSynced = 0;
  let menuSynced = false;

  if (token) {
    try {
      menuItemsSynced = await syncMenuFromCloud(token);
      menuSynced = true;
    } catch (e: any) {
      return {
        usersSynced: usersResult.count,
        menuItemsSynced: 0,
        menuSynced: false,
        error: e?.message || 'Menu sync failed',
      };
    }
  }

  return {
    usersSynced: usersResult.count,
    menuItemsSynced,
    menuSynced,
  };
}
