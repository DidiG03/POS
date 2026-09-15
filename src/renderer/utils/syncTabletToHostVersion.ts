import { emitPosSyncCatchup } from './posReadCache';
import {
  HOST_VERSION_STORAGE_KEY,
  isHostRendererHref,
  planHostVersionSync,
} from './hostVersionSync';

export async function syncTabletToHostVersion(): Promise<void> {
  const ping = (window as any).api?.health?.ping;
  if (typeof ping !== 'function') return;
  try {
    const h = await ping();
    const next = String(h?.appVersion || '').trim();
    if (!next) return;
    let previous: string | null = null;
    try {
      previous = localStorage.getItem(HOST_VERSION_STORAGE_KEY);
    } catch {
      previous = null;
    }
    const plan = planHostVersionSync({
      previous,
      next,
      servedFromHostRenderer: isHostRendererHref(
        String(window.location.href || ''),
      ),
    });
    if (plan.persist) {
      try {
        localStorage.setItem(HOST_VERSION_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
    if (plan.invalidate) emitPosSyncCatchup();
    if (plan.reload) window.location.reload();
  } catch {
    // host unreachable — next visibility / SSE open retries
  }
}
