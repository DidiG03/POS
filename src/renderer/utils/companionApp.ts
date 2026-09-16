/** Standalone Electron companions (KDS / Admin) that talk HTTP to a POS host. */

export function isKdsApp(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__KDS_APP__);
}

export function isAdminApp(): boolean {
  return (
    typeof window !== 'undefined' && Boolean((window as any).__ADMIN_APP__)
  );
}

export function isCompanionApp(): boolean {
  return isKdsApp() || isAdminApp();
}

export function companionDiscover():
  | {
      discover?: () => Promise<unknown[]>;
      lanFetch?: (input: unknown) => Promise<unknown>;
    }
  | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as any).adminApp || (window as any).kdsApp;
}
