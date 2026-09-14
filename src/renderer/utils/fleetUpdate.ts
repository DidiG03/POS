import type { UpdateStatusDTO } from '@shared/ipc';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostUpdates() {
  return (window as any).api?.hostUpdates as
    | {
        getStatus?: () => Promise<UpdateStatusDTO>;
        check?: () => Promise<{ success?: boolean; error?: string }>;
        download?: () => Promise<{ success?: boolean; error?: string }>;
        install?: () => Promise<{ success?: boolean; error?: string }>;
      }
    | undefined;
}

function localUpdater() {
  return (window as any).api?.updater;
}

export function isAdminCompanion(): boolean {
  return (
    typeof window !== 'undefined' && Boolean((window as any).__ADMIN_APP__)
  );
}

export async function loadFleetStatus(): Promise<{
  admin: UpdateStatusDTO | null;
  pos: UpdateStatusDTO | null;
}> {
  const local = localUpdater();
  const host = hostUpdates();
  const [admin, pos] = await Promise.all([
    local?.getUpdateStatus?.().catch(() => null) ?? Promise.resolve(null),
    host?.getStatus?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  return { admin, pos };
}

function resultError(value: unknown): string | null {
  const msg =
    value && typeof value === 'object' && 'error' in value
      ? String((value as { error?: string }).error || '')
      : '';
  if (!msg) return null;
  if (
    /disabled in development|auto-updates are disabled|no update available/i.test(
      msg,
    )
  ) {
    return null;
  }
  return msg;
}

function collectErrors(
  results: PromiseSettledResult<unknown>[],
): string | undefined {
  const errors = results
    .map((r) => {
      if (r.status === 'rejected') {
        return resultError({ error: String(r.reason?.message || r.reason) });
      }
      return resultError(r.value);
    })
    .filter((msg): msg is string => Boolean(msg));
  return errors.length ? errors.join('\n') : undefined;
}

export async function checkFleetUpdates(): Promise<{ error?: string }> {
  const local = localUpdater();
  const host = hostUpdates();
  const results = await Promise.allSettled([
    local?.checkForUpdates?.() ?? Promise.resolve(null),
    host?.check?.() ?? Promise.resolve(null),
  ]);
  await delay(1200);
  const error = collectErrors(results);
  return error ? { error } : {};
}

export async function downloadFleetUpdates(): Promise<{ error?: string }> {
  const local = localUpdater();
  const host = hostUpdates();
  const results = await Promise.allSettled([
    local?.downloadUpdate?.() ?? Promise.resolve(null),
    host?.download?.() ?? Promise.resolve(null),
  ]);
  const error = collectErrors(results);
  return error ? { error } : {};
}

/** Push KDS + POS first, then restart this Admin app if it has a download. */
export async function installFleetUpdates(): Promise<{ error?: string }> {
  const local = localUpdater();
  const host = hostUpdates();
  try {
    await host?.install?.();
  } catch {
    // POS may quit before the HTTP response returns.
  }
  await delay(400);
  const admin = await local?.getUpdateStatus?.().catch(() => null);
  if (admin?.downloaded) {
    try {
      await local.installUpdate();
    } catch (e: any) {
      return { error: String(e?.message || e || 'Failed to install Admin') };
    }
  }
  return {};
}
