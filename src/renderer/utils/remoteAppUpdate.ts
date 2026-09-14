type CompanionUpdater = {
  checkForUpdates?: () => Promise<unknown>;
  downloadUpdate?: () => Promise<unknown>;
  getUpdateStatus?: () => Promise<{
    hasUpdate?: boolean;
    downloaded?: boolean;
  } | null>;
  installUpdate?: () => Promise<unknown>;
};

function kdsUpdater(): CompanionUpdater | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    (window as any).kdsApp?.updater ?? (window as any).api?.updater ?? undefined
  );
}

export async function applyRemoteAppUpdate(
  action: unknown,
  updater: CompanionUpdater | undefined = kdsUpdater(),
): Promise<void> {
  if (!updater) return;
  if (action === 'check') {
    await updater.checkForUpdates?.();
    return;
  }
  if (action === 'download') {
    const status = await updater.getUpdateStatus?.();
    if (status?.hasUpdate) await updater.downloadUpdate?.();
    return;
  }
  if (action === 'install') {
    const status = await updater.getUpdateStatus?.();
    if (status?.downloaded) {
      await updater.installUpdate?.();
      return;
    }
    await updater.checkForUpdates?.();
  }
}

/** Kitchen displays honor Admin/POS "update all" over SSE. */
export function installRemoteAppUpdateListener(): void {
  if (typeof window === 'undefined') return;
  if (!(window as any).__KDS_APP__) return;
  const onUpdate = (ev: Event) => {
    const action = (ev as CustomEvent)?.detail?.action;
    void applyRemoteAppUpdate(action);
  };
  window.addEventListener('pos:appsUpdate', onUpdate);
}
