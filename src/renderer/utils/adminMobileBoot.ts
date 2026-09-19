import {
  hydrateCompanionHostFromNativeStore,
  resolveBackendHost,
} from './backendHost';

/** True for the Capacitor Admin web build (`vite.mobile.admin.config.ts`). */
export function isAdminMobileBuild(): boolean {
  return Boolean(import.meta.env.VITE_ADMIN_MOBILE_TARGET);
}

/**
 * Hash for the Admin iOS shell. Keep an in-app `/admin*` route; otherwise
 * go to PIN (`#/admin`) when a till is saved, or first-run setup.
 */
export function adminMobileLaunchHash(
  currentHash: string,
  host: string,
): string {
  const hash = String(currentHash || '');
  if (hash.startsWith('#/admin')) return hash;
  return String(host || '').trim() ? '#/admin' : '#/admin-setup';
}

/**
 * Mark this WebView as OneTap Admin and land on the admin shell before
 * `BootRoot` mounts the hash router. Electron Admin still uses preload.
 */
export async function bootAdminMobileShell(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!isAdminMobileBuild()) return;
  (window as any).__ADMIN_APP__ = true;
  await hydrateCompanionHostFromNativeStore();
  const next = adminMobileLaunchHash(
    window.location.hash || '',
    resolveBackendHost().host,
  );
  if (next !== (window.location.hash || '')) {
    window.location.hash = next;
  }
}
