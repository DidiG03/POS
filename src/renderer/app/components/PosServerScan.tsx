import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredPosHost } from '@shared/posHostDiscovery';
import {
  persistCompanionBackendHost,
  resolveBackendHost,
  syncBackendHostToLocalStorage,
} from '../../utils/backendHost';
import { discoverPosHostsInBrowser } from '../../utils/discoverPosHosts';
import {
  POS_OPEN_SERVER_SCAN,
  notifyBackendHostChanged,
} from '../../utils/posServerScanEvent';
import { invalidateHostScopedCaches } from '../../utils/posReadCache';
import { IconClose } from '../../components/icons';
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
  const backend = resolveBackendHost();

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const companion = ((window as any).adminApp || (window as any).kdsApp) as
        | { discover?: () => Promise<DiscoveredPosHost[]> }
        | undefined;
      if (companion?.discover) {
        const raw = await companion.discover();
        setHosts(Array.isArray(raw) ? raw : []);
      } else {
        const current = resolveBackendHost();
        const list = await discoverPosHostsInBrowser({
          seeds: [current.host],
          httpPort: Number(current.httpPort) || 3333,
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
        if ((window as any).__KDS_APP__ || (window as any).__ADMIN_APP__) {
          await persistCompanionBackendHost({ host: h.host, httpPort: port });
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
      currentHost={backend.host}
      currentPort={backend.httpPort}
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--pos-canvas)] px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pos-server-scan-title"
        className="pos-surface-panel relative w-full max-w-md overflow-hidden shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--pos-border)] px-4 py-3">
          <div className="min-w-0">
            <div
              id="pos-server-scan-title"
              className="truncate text-[15px] font-semibold tracking-tight text-[color:var(--pos-fg)]"
            >
              {t('boot.configureServer')}
            </div>
            <div className="mt-0.5 text-[12px] text-[color:var(--pos-fg-muted)]">
              {t('boot.cannotReachDetail')}
            </div>
          </div>
          <button
            type="button"
            className="pos-icon-btn -mr-1 shrink-0"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <div className="p-4">
          <PosServerScanPanel autoScan onConnected={onClose} />
        </div>
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
