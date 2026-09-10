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
    const timer = window.setInterval(load, 8000);
    window.addEventListener('pos:settingsChanged', load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('pos:settingsChanged', load);
    };
  }, [hasKds, hydrated]);

  if (!hydrated) return 'loading';
  if (!hasKds) return 'no';
  if (masterOn == null) return 'loading';
  return masterOn ? 'yes' : 'no';
}
