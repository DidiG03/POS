import {
  installFleetUpdates,
  isAdminCompanion,
  prepareFleetUpdates,
  summarizeFleetStatus,
} from './fleetUpdate';

type MessageBoxOpts = {
  type?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  message: string;
  detail?: string;
};

async function showBox(opts: MessageBoxOpts): Promise<{ response: number }> {
  const adminApp = (window as any).adminApp as
    | {
        showMessageBox?: (
          input: MessageBoxOpts,
        ) => Promise<{ response: number }>;
      }
    | undefined;
  if (adminApp?.showMessageBox) return adminApp.showMessageBox(opts);
  if ((opts.buttons?.length || 0) > 1) {
    return { response: window.confirm(opts.detail || opts.message) ? 0 : 1 };
  }
  window.alert([opts.message, opts.detail].filter(Boolean).join('\n\n'));
  return { response: 0 };
}

async function runAdminFleetMenuCheck(): Promise<void> {
  try {
    const result = await prepareFleetUpdates();
    const summary = summarizeFleetStatus({
      admin: result.admin,
      pos: result.pos,
    });
    if (result.error && !summary.hasUpdate) {
      await showBox({
        type: /development/i.test(result.error) ? 'info' : 'error',
        message: /development/i.test(result.error)
          ? 'Updates are disabled in development'
          : 'Could not check for updates',
        detail: result.error,
      });
      return;
    }
    if (!summary.readyToInstall) {
      await showBox({
        type: summary.posUnreachable ? 'warning' : 'info',
        message: summary.title,
        detail: result.error
          ? `${summary.detail}\n\n${result.error}`
          : summary.detail,
      });
      return;
    }
    const confirm = await showBox({
      type: 'info',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: summary.title,
      detail: summary.detail,
    });
    if (confirm.response === 0) {
      const installed = await installFleetUpdates();
      if (installed.error) {
        await showBox({
          type: 'error',
          message: 'Could not install the update',
          detail: installed.error,
        });
      }
    }
  } catch (error) {
    await showBox({
      type: 'error',
      message: 'Could not check for updates',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await (window as any).adminApp?.fleetMenuFinished?.();
    } catch {
      // ignore
    }
  }
}

/** Admin on a separate PC: File/Help Check for Updates drives POS + KDS + Admin. */
export function installAdminFleetMenuListener(): void {
  if (typeof window === 'undefined') return;
  if (!isAdminCompanion()) return;
  window.addEventListener('updater:run-fleet-check', () => {
    void runAdminFleetMenuCheck();
  });
}
