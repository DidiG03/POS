import type { UpdateStatusDTO } from '@shared/ipc';
import {
  isMissingUpdateFeedError,
  userFacingUpdaterError,
} from '@shared/updateFeedError';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type HostUpdatesApi = {
  getStatus?: () => Promise<UpdateStatusDTO | null>;
  check?: () => Promise<{ success?: boolean; error?: string }>;
  download?: () => Promise<{ success?: boolean; error?: string }>;
  install?: () => Promise<{ success?: boolean; error?: string }>;
};

type LocalUpdaterApi = {
  getUpdateStatus?: () => Promise<UpdateStatusDTO | null>;
  checkForUpdates?: () => Promise<{ success?: boolean; error?: string }>;
  checkDownloadAndPrepare?: () => Promise<{
    success?: boolean;
    error?: string;
    hasUpdate?: boolean;
    downloaded?: boolean;
  }>;
  downloadUpdate?: () => Promise<{ success?: boolean; error?: string }>;
  installUpdate?: () => Promise<{ success?: boolean; error?: string }>;
};

function hostUpdates(): HostUpdatesApi | undefined {
  return (window as any).api?.hostUpdates as HostUpdatesApi | undefined;
}

function localUpdater(): LocalUpdaterApi | undefined {
  return (window as any).api?.updater as LocalUpdaterApi | undefined;
}

export function isAdminCompanion(): boolean {
  return (
    typeof window !== 'undefined' && Boolean((window as any).__ADMIN_APP__)
  );
}

export function isStatusBusy(
  status: UpdateStatusDTO | null | undefined,
): boolean {
  if (!status) return false;
  return Boolean(status.checking || status.downloading);
}

export async function waitWhileBusy(
  getStatus: () => Promise<UpdateStatusDTO | null | undefined>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<UpdateStatusDTO | null> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const intervalMs = opts?.intervalMs ?? 800;
  const started = Date.now();
  let last: UpdateStatusDTO | null = null;
  while (Date.now() - started < timeoutMs) {
    last = (await getStatus().catch(() => null)) ?? null;
    if (!isStatusBusy(last)) return last;
    await delay(intervalMs);
  }
  return last;
}

export function summarizeFleetStatus(input: {
  admin: UpdateStatusDTO | null;
  pos: UpdateStatusDTO | null;
}): {
  readyToInstall: boolean;
  hasUpdate: boolean;
  posUnreachable: boolean;
  title: string;
  detail: string;
} {
  const posUnreachable = !input.pos;
  const adminReady = Boolean(input.admin?.downloaded);
  const posReady = Boolean(input.pos?.downloaded);
  const adminUpdate = Boolean(input.admin?.hasUpdate);
  const posUpdate = Boolean(input.pos?.hasUpdate);
  const lines: string[] = [];

  if (posUnreachable) {
    lines.push(
      'POS till cannot be reached. Is OneTap POS running on the other computer, on the same network?',
    );
  } else if (posReady) {
    lines.push(
      `POS till ${input.pos?.updateInfo?.version || ''} is ready to install.`.replace(
        /\s+/g,
        ' ',
      ),
    );
  } else if (posUpdate) {
    lines.push(
      `POS till can update from ${input.pos?.currentVersion || '?'} to ${input.pos?.updateInfo?.version}.`,
    );
  } else {
    lines.push(
      `POS till ${input.pos?.currentVersion || ''} is up to date.`.trim(),
    );
  }

  if (adminReady) {
    lines.push(
      `This Admin app ${input.admin?.updateInfo?.version || ''} is ready to install.`.replace(
        /\s+/g,
        ' ',
      ),
    );
  } else if (adminUpdate) {
    lines.push(
      `This Admin app can update from ${input.admin?.currentVersion || '?'} to ${input.admin?.updateInfo?.version}.`,
    );
  } else if (input.admin) {
    lines.push(
      `This Admin app ${input.admin.currentVersion || ''} is up to date.`.trim(),
    );
  }

  lines.push(
    'Kitchen displays on this till’s network update when you install, if they are online.',
  );

  return {
    readyToInstall: adminReady || posReady,
    hasUpdate: adminUpdate || posUpdate || adminReady || posReady,
    posUnreachable,
    title: posUnreachable
      ? 'Could not reach the POS till'
      : adminReady || posReady
        ? 'Updates ready to install'
        : adminUpdate || posUpdate
          ? 'Updates available'
          : 'You’re up to date',
    detail: lines.join('\n'),
  };
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
  const raw =
    value && typeof value === 'object' && 'error' in value
      ? (value as { error?: unknown }).error
      : value;
  if (isMissingUpdateFeedError(raw)) return null;
  const msg = String(
    (value && typeof value === 'object' && 'error' in value
      ? (value as { error?: string }).error
      : '') || '',
  );
  if (!msg) return null;
  if (
    /disabled in development|auto-updates are disabled|no update available/i.test(
      msg,
    )
  ) {
    return null;
  }
  return userFacingUpdaterError(msg);
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

async function waitForLocalIdle(): Promise<void> {
  const local = localUpdater();
  if (!local?.getUpdateStatus) return;
  await waitWhileBusy(
    () => local.getUpdateStatus?.() ?? Promise.resolve(null),
    {
      timeoutMs: 10 * 60_000,
    },
  );
}

async function waitForHostIdle(): Promise<UpdateStatusDTO | null> {
  const host = hostUpdates();
  if (!host?.getStatus) return null;
  return waitWhileBusy(() => host.getStatus?.() ?? Promise.resolve(null), {
    timeoutMs: 10 * 60_000,
  });
}

export async function checkFleetUpdates(): Promise<{ error?: string }> {
  const local = localUpdater();
  const host = hostUpdates();
  const results = await Promise.allSettled([
    local?.checkForUpdates?.() ?? Promise.resolve(null),
    host?.check?.() ?? Promise.resolve(null),
  ]);
  await Promise.all([waitForLocalIdle(), waitForHostIdle()]);
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
  await Promise.all([waitForLocalIdle(), waitForHostIdle()]);
  const error = collectErrors(results);
  return error ? { error } : {};
}

/**
 * One Admin action: check + download this Admin app and the POS till it is
 * connected to (KDS is told over SSE). Used by the native menu on a
 * separate Admin PC.
 */
export async function prepareFleetUpdates(): Promise<{
  error?: string;
  admin: UpdateStatusDTO | null;
  pos: UpdateStatusDTO | null;
}> {
  const local = localUpdater();
  const host = hostUpdates();
  const results = await Promise.allSettled([
    local?.checkDownloadAndPrepare?.() ??
      (async () => {
        await local?.checkForUpdates?.();
        const status = await local?.getUpdateStatus?.();
        if (status?.hasUpdate && !status.downloaded) {
          await local?.downloadUpdate?.();
        }
        return status;
      })(),
    host?.download?.() ?? host?.check?.() ?? Promise.resolve(null),
  ]);
  await Promise.all([waitForLocalIdle(), waitForHostIdle()]);
  const { admin, pos } = await loadFleetStatus();
  const error = collectErrors(results);
  return { error, admin, pos };
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
      await local?.installUpdate?.();
    } catch (e: any) {
      return { error: String(e?.message || e || 'Failed to install Admin') };
    }
  }
  return {};
}
