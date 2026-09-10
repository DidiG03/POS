export const HOST_VERSION_STORAGE_KEY = 'pos-host-app-version';

export function isHostRendererHref(href: string): boolean {
  try {
    const u = new URL(href);
    return u.pathname === '/renderer' || u.pathname.startsWith('/renderer/');
  } catch {
    return /\/renderer(\/|\?|#|$)/.test(String(href || ''));
  }
}

export function planHostVersionSync(opts: {
  previous: string | null;
  next: string;
  servedFromHostRenderer: boolean;
}): { persist: boolean; invalidate: boolean; reload: boolean } {
  const next = String(opts.next || '').trim();
  if (!next) {
    return { persist: false, invalidate: false, reload: false };
  }
  if (opts.previous == null || opts.previous === '') {
    return { persist: true, invalidate: false, reload: false };
  }
  if (opts.previous === next) {
    return { persist: false, invalidate: false, reload: false };
  }
  return {
    persist: true,
    invalidate: true,
    reload: opts.servedFromHostRenderer,
  };
}
