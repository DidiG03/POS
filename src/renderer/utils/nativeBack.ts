/**
 * Android Back button for the Waiter app.
 *
 * Without a listener the system Back closed the whole app, mid-order, and
 * the unsent draft went with it. Back now behaves like Back inside the app:
 *
 *   1. an open dialog closes;
 *   2. an order screen with unsent items asks before leaving;
 *   3. any other screen returns to the floor plan (or the previous screen);
 *   4. on the floor plan / login, the app goes to the background instead of
 *      exiting, so the waiter stays signed in.
 */

export type BackAction =
  | 'close-dialog'
  | 'confirm-leave-order'
  | 'go-home'
  | 'history-back'
  | 'minimize';

/** Pure core, for tests. */
export function decideBackAction(input: {
  dialogOpen: boolean;
  route: string;
  homeRoute: string;
  unsentCount: number;
}): BackAction {
  const route = String(input.route || '/').replace(/\/+$/, '') || '/';
  const home = String(input.homeRoute || '/app/tables').replace(/\/+$/, '');
  if (input.dialogOpen) return 'close-dialog';
  if (route === '/' || route === home) return 'minimize';
  if (route.startsWith('/app/order') && input.unsentCount > 0) {
    return 'confirm-leave-order';
  }
  if (route.startsWith('/app/')) return 'go-home';
  return 'history-back';
}

function topDialog(): HTMLElement | null {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
    ),
  ).filter((el) => el.offsetParent !== null || el.getClientRects().length);
  return all.length ? all[all.length - 1] : null;
}

/**
 * Close the topmost dialog the way a person would: Escape (Modal and the
 * payment sheet listen for it), then the dimmed backdrop around it.
 */
function closeDialog(dialog: HTMLElement): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  window.setTimeout(() => {
    if (!dialog.isConnected) return;
    const parent = dialog.parentElement;
    const backdrop =
      parent?.querySelector<HTMLElement>(':scope > button.absolute') || parent;
    backdrop?.click();
  }, 60);
}

function currentRoute(): string {
  const hash = String(window.location.hash || '').replace(/^#/, '');
  return hash.split('?')[0] || '/';
}

export async function installNativeBackButton(): Promise<void> {
  const { App } = await import('@capacitor/app');
  await App.addListener('backButton', async () => {
    const [{ useTicketStore }, { useLicenseCapabilities }, i18n] =
      await Promise.all([
        import('../stores/ticket'),
        import('../stores/licenseCapabilities'),
        import('../i18n/config').then((m) => m.default),
      ]);
    const hasTables = useLicenseCapabilities.getState().hasTables !== false;
    const homeRoute = hasTables ? '/app/tables' : '/app/order';
    const unsentCount = (useTicketStore.getState().lines || []).filter(
      (l: any) => l?.staged && !l?.voided,
    ).length;
    const dialog = topDialog();
    const action = decideBackAction({
      dialogOpen: Boolean(dialog),
      route: currentRoute(),
      homeRoute,
      unsentCount,
    });
    if (action === 'close-dialog' && dialog) {
      closeDialog(dialog);
      return;
    }
    if (action === 'confirm-leave-order') {
      // The draft is kept on the phone (see `ticketDraft`), but leaving
      // with unsent items is still worth a question.
      const ok = window.confirm(
        i18n.t('order.backLeaveUnsent', { count: unsentCount }),
      );
      if (ok) window.location.hash = `#${homeRoute}`;
      return;
    }
    if (action === 'go-home') {
      window.location.hash = `#${homeRoute}`;
      return;
    }
    if (action === 'history-back') {
      window.history.back();
      return;
    }
    await App.minimizeApp().catch(() => undefined);
  });
}
