import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredPosHost } from '@shared/posHostDiscovery';
import {
  persistKdsBackendHost,
  resolveBackendHost,
  syncBackendHostToLocalStorage,
} from '../../utils/backendHost';
import { discoverPosHostsInBrowser } from '../../utils/discoverPosHosts';
import {
  POS_OPEN_SERVER_SCAN,
  notifyBackendHostChanged,
} from '../../utils/posServerScanEvent';
import { invalidateHostScopedCaches } from '../../utils/posReadCache';
import { BrandMark } from '../../components/BrandMark';
import { PosHostPicker } from './PosHostPicker';

export function PosServerScanPanel({
  autoScan = false,
  onConnected,
}: {
  autoScan?: boolean;
  onConnected?: () => void;
}) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<DiscoveredPosHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [busyHost, setBusyHost] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const kds = (window as any).kdsApp as
        | { discover?: () => Promise<DiscoveredPosHost[]> }
        | undefined;
      if (kds?.discover) {
        const raw = await kds.discover();
        setHosts(Array.isArray(raw) ? raw : []);
      } else {
        const backend = resolveBackendHost();
        const list = await discoverPosHostsInBrowser({
          seeds: [backend.host],
          httpPort: Number(backend.httpPort) || 3333,
        });
        setHosts(list);
      }
      setScanned(true);
    } catch {
      setHosts([]);
      setScanned(true);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (autoScan) void scan();
  }, [autoScan, scan]);

  const connectTo = useCallback(
    async (h: DiscoveredPosHost) => {
      setBusyHost(h.host);
      const port = Number(h.httpPort) || 3333;
      try {
        if ((window as any).__KDS_APP__) {
          await persistKdsBackendHost({ host: h.host, httpPort: port });
          return;
        }
        syncBackendHostToLocalStorage({
          host: h.host,
          httpPort: String(port),
          httpsPort: h.httpsPort ? String(h.httpsPort) : '3443',
        });
        invalidateHostScopedCaches();
        notifyBackendHostChanged();
        onConnected?.();
        setBusyHost(null);
      } catch {
        setBusyHost(null);
      }
    },
    [onConnected],
  );

  return (
    <PosHostPicker
      hosts={hosts}
      scanning={scanning}
      scanned={scanned}
      busyHost={busyHost}
      onScan={() => void scan()}
      onSelect={(h) => void connectTo(h)}
      labels={{
        scan: t('boot.scan'),
        scanning: t('boot.scanning'),
        empty: t('boot.noneFound'),
      }}
    />
  );
}

export function PosServerScanOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center px-6">
      <button
        type="button"
        className="absolute inset-0 bg-black/75"
        style={{ minHeight: 0 }}
        aria-label={t('common.close')}
        onClick={onClose}
      />
      <div className="relative z-10 flex w-full max-w-md flex-col items-center gap-5">
        <BrandMark size="lg" holdToScan={false} />
        <PosServerScanPanel autoScan onConnected={onClose} />
      </div>
    </div>
  );
}

/** Mount once at the app root so a long-press on the logo can reopen Scan. */
export function PosServerScanHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(POS_OPEN_SERVER_SCAN, onOpen);
    return () => window.removeEventListener(POS_OPEN_SERVER_SCAN, onOpen);
  }, []);
  if (!open) return null;
  return <PosServerScanOverlay onClose={() => setOpen(false)} />;
}
