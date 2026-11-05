import { useEffect, useState } from 'react';
import { useLicenseCapabilities } from '../stores/licenseCapabilities';

export type KdsOrdersAccess = 'loading' | 'yes' | 'no';

/**
 * Waiter-station Orders tab: restaurant KDS license AND admin master switch.
 * Missing `kds.enabled` stays on (same as kitchen routing).
 */
export function useKdsOrdersAccess(): KdsOrdersAccess {
  const hydrated = useLicenseCapabilities((s) => s.hydrated);
  const hasKds = useLicenseCapabilities((s) => s.hasKds);
  const [masterOn, setMasterOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!hasKds) {
      setMasterOn(false);
      return;
    }
    let cancelled = false;
    const load = () => {
      void window.api.settings
        .get()
        .then((s: { kds?: { enabled?: boolean } }) => {
          if (!cancelled) setMasterOn(s?.kds?.enabled !== false);
        })
        .catch(() => {
          if (!cancelled) setMasterOn(false);
        });
    };
    load();
    // No timer: every device fetched the whole settings every 8 s for this
    // one switch (audit 2026-11, M6). A change arrives as
    // `pos:settingsChanged` (IPC on the till, the event stream on phones);
    // after a reconnect or coming back to the foreground, an event may
    // have been missed, so it reads once then.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('pos:settingsChanged', load);
    window.addEventListener('pos:syncCatchup', load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:settingsChanged', load);
      window.removeEventListener('pos:syncCatchup', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hasKds, hydrated]);

  if (!hydrated) return 'loading';
  if (!hasKds) return 'no';
  if (masterOn == null) return 'loading';
  return masterOn ? 'yes' : 'no';
}
