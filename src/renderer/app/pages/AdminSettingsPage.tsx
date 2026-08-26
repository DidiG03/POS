import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  FiscalReviewDTO,
  NetworkPrinterDTO,
  UpdateStatusDTO,
} from '@shared/ipc';
import { toast } from '../../stores/toasts';
import {
  ALL_KDS_STATIONS,
  kdsStationLabel,
  type KdsStation,
} from '@shared/kdsStations';
import { KDS_BUMP_BAR_PROGRAMMING } from '../../utils/kdsBumpBar';
import FloorCanvas from '../components/FloorCanvas';
import { useSessionStore } from '../../stores/session';
import { useAdminSessionStore } from '../../stores/adminSession';

type MemoryStats = {
  current: { heapUsed: number; rss: number; timestamp: number };
  average: { heapUsed: number; rss: number };
  peak: { heapUsed: number; rss: number; timestamp: number };
  trend: 'increasing' | 'decreasing' | 'stable';
  formatted: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
    external: string;
  };
};

type Section =
  | { key: 'printer'; label: string }
  | { key: 'areas'; label: string }
  | { key: 'googleCalendar'; label: string }
  | { key: 'kds'; label: string }
  | { key: 'preferences'; label: string }
  | { key: 'fiscal'; label: string }
  | { key: 'backups'; label: string }
  | { key: 'memory'; label: string }
  | { key: 'cloud'; label: string }
  | { key: 'updates'; label: string }
  | { key: 'billing'; label: string }
  | { key: 'lan'; label: string }
  | { key: 'about'; label: string };

const sections: Section[] = [
  { key: 'printer', label: 'Printer' },
  { key: 'areas', label: 'Table Areas' },
  { key: 'googleCalendar', label: 'Google Calendar' },
  { key: 'kds', label: 'Kitchen Display' },
  { key: 'preferences', label: 'Preferences' },
  { key: 'fiscal', label: 'Fiskalizimi' },
  { key: 'backups', label: 'Backups' },
  { key: 'memory', label: 'Memory Monitoring' },
  { key: 'cloud', label: 'Log In to Cloud' },
  { key: 'updates', label: 'System Updates' },
  { key: 'billing', label: 'Billing' },
  { key: 'lan', label: 'LAN / Tablets' },
  { key: 'about', label: 'Business Info' },
];

function ChevronRight() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="pos-icon opacity-70"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M9.22 4.22a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L14.94 12 9.22 5.28a.75.75 0 010-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function IconWrap({ children }: { children: any }) {
  return (
    <span className="w-8 h-8 rounded bg-gray-900/50 border border-gray-700 flex items-center justify-center">
      {children}
    </span>
  );
}

function SectionIcon({ k }: { k: Section['key'] }) {
  const common = {
    className: 'pos-icon opacity-90',
    'aria-hidden': true,
  } as any;
  if (k === 'printer')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M7 8V4h10v4M7 17h10v3H7v-3Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M6 17H5a3 3 0 0 1-3-3v-2a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v2a3 3 0 0 1-3 3h-1"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'areas')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M4 6h16M4 12h16M4 18h16"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          <path
            d="M7 6v12M17 6v12"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            opacity="0.7"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'googleCalendar')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M7 3v2M17 3v2M4 9h16M6 5h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M8 13h3v3H8v-3ZM13 13h3v3h-3v-3Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'kds')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M4 5h16v10H4V5Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M8 19h8M12 15v4"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'preferences')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M4 7h10M18 7h2M4 17h2M10 17h10"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          <path
            d="M14 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM10 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"
            stroke="currentColor"
            strokeWidth="1.75"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'fiscal')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M7 3h10v18H7V3Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M9 7h6M9 11h6M9 15h4"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'backups')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M20 7.5A4.5 4.5 0 0 0 11.6 5 4 4 0 0 0 4 8.5C4 11 6 13 8.5 13H19a3 3 0 0 0 1-5.5Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M12 12v7m0 0-3-3m3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'memory')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M7 7h10v10H7V7Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M4 10h2M4 14h2M18 10h2M18 14h2M10 4v2M14 4v2M10 18v2M14 18v2"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            opacity="0.8"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'cloud')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M20 17.5a4.5 4.5 0 0 0-2.8-8.4A5 5 0 0 0 7.3 8.3 4 4 0 0 0 8 16h11.5A3.5 3.5 0 0 0 20 17.5Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M12 11v6m0 0 2-2m-2 2-2-2"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'updates')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M20 12a8 8 0 1 1-2.34-5.66"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          <path
            d="M20 4v6h-6"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'billing')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M3 7h18v10H3V7Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M3 10h18"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          <path
            d="M7 14h4"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </IconWrap>
    );
  if (k === 'lan')
    return (
      <IconWrap>
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path
            d="M12 19h.01"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M8.5 15.5a5 5 0 0 1 7 0"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          <path
            d="M5 12a10 10 0 0 1 14 0"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            opacity="0.8"
          />
        </svg>
      </IconWrap>
    );
  // about/business info
  return (
    <IconWrap>
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 17v-5"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M12 8h.01"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          stroke="currentColor"
          strokeWidth="1.75"
        />
      </svg>
    </IconWrap>
  );
}

export default function AdminSettingsPage() {
  const [selected, setSelected] = useState<Section['key']>('printer');
  return (
    <div className="h-full grid grid-cols-2 gap-4 min-h-0">
      <div className="bg-gray-800 rounded overflow-auto">
        <ul className="divide-y divide-gray-700">
          {sections.map((s) => (
            <li key={s.key}>
              <button
                className={`w-full px-4 py-3 hover:bg-gray-700 ${selected === s.key ? 'bg-gray-700' : ''}`}
                onClick={() => setSelected(s.key)}
                type="button"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <SectionIcon k={s.key} />
                    <span>{s.label}</span>
                  </div>
                  <ChevronRight />
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="bg-gray-800 rounded p-4 overflow-auto">
        {selected === 'printer' && <PrinterSettings />}
        {selected === 'areas' && <AreasSettings />}
        {selected === 'googleCalendar' && <GoogleCalendarSettings />}
        {selected === 'kds' && <KdsSettings />}
        {selected === 'preferences' && <PreferencesSettings />}
        {selected === 'fiscal' && <FiscalSettings />}
        {selected === 'backups' && <BackupsSettings />}
        {selected === 'memory' && <MemoryMonitorSection />}
        {selected === 'cloud' && <CloudSettings />}
        {selected === 'updates' && <SystemUpdatesSettings />}
        {selected === 'billing' && <BillingSettings />}
        {selected === 'lan' && <LanSettings />}
        {selected === 'about' && <AboutSettings />}
      </div>
    </div>
  );
}

function SystemUpdatesSettings() {
  const [status, setStatus] = useState<UpdateStatusDTO | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);

  async function loadStatus() {
    try {
      const s = await window.api.updater.getUpdateStatus();
      setStatus(s);
    } catch {
      // ignore (updater may be unavailable)
    }
  }

  useEffect(() => {
    void loadStatus();
    const handleEvent = (e: any) => {
      const { event, data } = (e as CustomEvent<any>)?.detail || {};
      if (event === 'checking') {
        setChecking(true);
        setError(null);
      }
      if (event === 'update-available' || event === 'update-not-available') {
        setChecking(false);
        setLastCheckedAt(Date.now());
        void loadStatus();
      }
      if (event === 'download-progress') {
        setDownloadProgress(
          typeof data?.percent === 'number' ? data.percent : null,
        );
      }
      if (event === 'update-downloaded') {
        setDownloadProgress(null);
        void loadStatus();
      }
      if (event === 'error') {
        setChecking(false);
        setError(String(data?.message || 'Update error'));
      }
    };
    window.addEventListener('updater:event', handleEvent as EventListener);
    return () =>
      window.removeEventListener('updater:event', handleEvent as EventListener);
  }, []);

  async function checkNow() {
    setChecking(true);
    setError(null);
    setLastCheckedAt(Date.now());
    try {
      const r = await window.api.updater.checkForUpdates();
      if (r?.error) setError(String(r.error));
    } catch (e: any) {
      setError(String(e?.message || 'Failed to check for updates'));
    } finally {
      setChecking(false);
      void loadStatus();
    }
  }

  async function download() {
    setError(null);
    try {
      const r = await window.api.updater.downloadUpdate();
      if (r?.error) setError(String(r.error));
    } catch (e: any) {
      setError(String(e?.message || 'Failed to download update'));
    }
  }

  async function install() {
    if (!confirm('The app will restart to install the update. Continue?'))
      return;
    try {
      await window.api.updater.installUpdate();
    } catch (e: any) {
      setError(String(e?.message || 'Failed to install update'));
    }
  }

  const hasUpdate = Boolean(status?.hasUpdate && status?.updateInfo?.version);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold">System Updates</div>
          <div className="text-xs opacity-70">
            Check for new POS versions and install updates without reinstalling.
            Kitchen displays update separately on each KDS device.
          </div>
        </div>
        <button
          className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm disabled:opacity-60"
          onClick={() => void checkNow()}
          disabled={checking}
          type="button"
        >
          {checking ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      <div className="rounded border border-gray-700 bg-gray-900/40 p-3">
        {hasUpdate ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-semibold">Update available</div>
                <div className="text-sm opacity-80">
                  Version{' '}
                  <span className="font-mono">
                    {status?.updateInfo?.version}
                  </span>
                </div>
              </div>
              {!status?.downloaded ? (
                <button
                  className="px-3 py-2 rounded bg-blue-700 hover:bg-blue-600 text-sm"
                  onClick={() => void download()}
                  type="button"
                >
                  Download
                </button>
              ) : (
                <button
                  className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 text-sm"
                  onClick={() => void install()}
                  type="button"
                >
                  Install & Restart
                </button>
              )}
            </div>
            {status?.updateInfo?.releaseNotes && (
              <details className="mt-3 text-xs opacity-90">
                <summary className="cursor-pointer">Release notes</summary>
                <div className="mt-2 whitespace-pre-wrap opacity-90">
                  {String(status.updateInfo.releaseNotes)}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="text-sm opacity-80">
            No update available right now.
          </div>
        )}

        {downloadProgress !== null && (
          <div className="mt-4">
            <div className="text-xs opacity-70 mb-1">
              Downloading… {Math.round(downloadProgress)}%
            </div>
            <div className="w-full bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-400 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(0, Math.min(100, downloadProgress))}%`,
                }}
              />
            </div>
          </div>
        )}

        {lastCheckedAt && (
          <div className="mt-3 text-xs opacity-60">
            Last checked: {new Date(lastCheckedAt).toLocaleString()}
          </div>
        )}
      </div>

      {error && <div className="text-sm text-rose-300">{error}</div>}
    </div>
  );
}

function BillingSettings() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      const s = await ((window.api as any).billing.getStatusLive?.() ??
        (window.api as any).billing.getStatus());
      setStatus(s);
    } catch (e: any) {
      setErr(String(e?.message || 'Could not load billing status'));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const billingEnabled = Boolean(status?.billingEnabled);
  const st = String(status?.status || 'ACTIVE').toUpperCase();
  const periodEnd = status?.currentPeriodEnd
    ? new Date(status.currentPeriodEnd).toLocaleString()
    : null;
  const cancelAt = status?.cancelAt
    ? new Date(status.cancelAt).toLocaleString()
    : null;
  const cancelRequestedAt = status?.cancelRequestedAt
    ? new Date(status.cancelRequestedAt).toLocaleString()
    : null;
  const pausedAt = status?.pausedAt
    ? new Date(status.pausedAt).toLocaleString()
    : null;
  const cancellationWarning =
    billingEnabled &&
    (Boolean(status?.cancelAt) ||
      (st === 'PAUSED' &&
        (String(status?.message || '')
          .toLowerCase()
          .includes('canceled') ||
          Boolean(status?.pausedAt) ||
          Boolean(status?.cancelRequestedAt))));

  async function openUrl(url?: string | null) {
    const u = String(url || '').trim();
    if (!u) return;
    // Electron: open in OS browser; Browser clients: window.open polyfill exists.
    await (window.api as any).system
      ?.openExternal?.(u)
      .catch(() => window.open(u, '_blank', 'noopener,noreferrer'));
  }

  async function payNow() {
    setBusy(true);
    setErr(null);
    try {
      const r = await (window.api as any).billing.createCheckoutSession();
      if (r?.error) {
        setErr(String(r.error));
        return;
      }
      await openUrl(r?.url);
    } catch (e: any) {
      setErr(String(e?.message || 'Could not start payment'));
    } finally {
      setBusy(false);
    }
  }

  async function manageBilling() {
    setBusy(true);
    setErr(null);
    try {
      const r = await (window.api as any).billing.createPortalSession?.();
      if (r?.error) {
        setErr(String(r.error));
        return;
      }
      await openUrl(r?.url);
    } catch (e: any) {
      setErr(String(e?.message || 'Could not open billing portal'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold">Billing</div>
          <div className="text-xs opacity-70">
            Manage your POS subscription and keep the system active.
          </div>
        </div>
        <button
          className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
          onClick={() => void refresh()}
          type="button"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="opacity-70">Loading…</div>
      ) : (
        <div className="rounded border border-gray-700 bg-gray-900/40 p-3">
          {!billingEnabled && (
            <div className="text-sm opacity-80">
              Billing is not enabled for this deployment.
            </div>
          )}
          {billingEnabled && (
            <>
              {cancellationWarning && (
                <div className="mb-3 rounded border border-amber-700 bg-amber-900/20 p-3 text-amber-200 text-sm">
                  <div className="font-semibold">Subscription cancellation</div>
                  <div className="mt-1 opacity-90">
                    {st === 'PAUSED'
                      ? 'This subscription was canceled. The POS is paused until you subscribe again.'
                      : cancelAt
                        ? `This subscription is set to cancel at period end: ${cancelAt}`
                        : 'This subscription has a cancellation request.'}
                  </div>
                  <div className="mt-2 text-xs opacity-80">
                    {cancelRequestedAt && (
                      <div>Cancel requested: {cancelRequestedAt}</div>
                    )}
                    {pausedAt && <div>Paused at: {pausedAt}</div>}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`text-xs px-2 py-1 rounded border ${
                    st === 'ACTIVE'
                      ? 'bg-emerald-900/30 border-emerald-800 text-emerald-100'
                      : st === 'PAST_DUE'
                        ? 'bg-amber-900/30 border-amber-800 text-amber-100'
                        : 'bg-rose-900/30 border-rose-800 text-rose-100'
                  }`}
                >
                  {st === 'ACTIVE'
                    ? 'Active'
                    : st === 'PAST_DUE'
                      ? 'Payment required'
                      : 'Paused'}
                </span>
                {periodEnd && (
                  <span className="text-xs opacity-70">
                    Period ends: {periodEnd}
                  </span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="px-3 py-2 rounded bg-blue-700 hover:bg-blue-600 text-sm disabled:opacity-50"
                  onClick={() => void payNow()}
                  disabled={busy}
                  type="button"
                >
                  Pay / Subscribe
                </button>
                <button
                  className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm disabled:opacity-50"
                  onClick={() => void manageBilling()}
                  disabled={busy}
                  type="button"
                >
                  Manage billing
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {err && <div className="text-sm text-rose-300">{err}</div>}
      {status?.message && (
        <div className="text-xs opacity-70">{String(status.message)}</div>
      )}
    </div>
  );
}

function PreferencesSettings() {
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState<string>('EUR');
  const [language, setLanguage] = useState<'en' | 'sq'>('en');
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [value, setValue] = useState<string>('10');
  const [requireMgrDiscount, setRequireMgrDiscount] = useState(true);
  const [requireMgrVoid, setRequireMgrVoid] = useState(true);
  const [requireMgrServiceRemoval, setRequireMgrServiceRemoval] =
    useState(true);
  const [autoCloseShiftEnabled, setAutoCloseShiftEnabled] = useState(false);
  const [autoCloseShiftHours, setAutoCloseShiftHours] = useState<12 | 24>(12);
  const [reservationNoShowEnabled, setReservationNoShowEnabled] =
    useState(false);
  const [reservationNoShowMinutes, setReservationNoShowMinutes] =
    useState<number>(20);
  const [status, setStatus] = useState<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        const cur =
          String((s as any)?.currency || 'EUR')
            .trim()
            .toUpperCase() || 'EUR';
        setCurrency(cur);
        const lang = String(
          (s as any)?.preferences?.language || 'en',
        ).toLowerCase();
        setLanguage(lang === 'sq' ? 'sq' : 'en');
        try {
          document.documentElement.lang = lang === 'sq' ? 'sq' : 'en';
        } catch {
          // ignore non-browser
        }
        const sc = (s as any)?.preferences?.serviceCharge || {};
        setEnabled(Boolean(sc.enabled));
        const m = String(sc.mode || 'PERCENT').toUpperCase();
        setMode(m === 'AMOUNT' ? 'AMOUNT' : 'PERCENT');
        setValue(sc.value != null ? String(sc.value) : '10');
        const approvals = (s as any)?.security?.approvals || {};
        setRequireMgrDiscount(approvals.requireManagerPinForDiscount !== false);
        setRequireMgrVoid(approvals.requireManagerPinForVoid !== false);
        setRequireMgrServiceRemoval(
          approvals.requireManagerPinForServiceChargeRemoval !== false,
        );
        const acs = (s as any)?.preferences?.autoCloseShift || {};
        setAutoCloseShiftEnabled(Boolean(acs.enabled));
        const h = Number(acs.hours);
        setAutoCloseShiftHours(h === 24 ? 24 : 12);
        const rns = (s as any)?.preferences?.reservationAutoNoShow || {};
        setReservationNoShowEnabled(Boolean(rns.enabled));
        const noShowMin = Number(rns.minutes);
        // Stored value is clamped to a safe range on save, but be defensive here.
        setReservationNoShowMinutes(
          Number.isFinite(noShowMin) && noShowMin >= 5 && noShowMin <= 240
            ? Math.round(noShowMin)
            : 20,
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    setStatus(null);
    const cur = String(currency || '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
      setStatus(t('preferences.currencyInvalid'));
      return;
    }
    const n = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      setStatus(t('preferences.invalidAmount'));
      return;
    }
    const noShowMins = Math.max(
      5,
      Math.min(240, Math.round(Number(reservationNoShowMinutes) || 0)),
    );
    if (
      reservationNoShowEnabled &&
      (!Number.isFinite(noShowMins) || noShowMins < 5)
    ) {
      setStatus(t('preferences.noShowGrace'));
      return;
    }
    await window.api.settings.update({
      currency: cur,
      security: {
        approvals: {
          requireManagerPinForDiscount: requireMgrDiscount,
          requireManagerPinForVoid: requireMgrVoid,
          requireManagerPinForServiceChargeRemoval: requireMgrServiceRemoval,
        },
      },
      preferences: {
        language,
        serviceCharge: { enabled, mode, value: n },
        autoCloseShift: {
          enabled: autoCloseShiftEnabled,
          hours: autoCloseShiftHours,
        },
        reservationAutoNoShow: {
          enabled: reservationNoShowEnabled,
          minutes: noShowMins,
        },
      },
    } as any);
    try {
      document.documentElement.lang = language === 'sq' ? 'sq' : 'en';
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(
        new CustomEvent('pos:localeChanged', {
          detail: { lng: language },
        }),
      );
    } catch {
      // ignore non-browser
    }
    setStatus(t('preferences.saved'));
  }

  return (
    <div>
      <div className="text-lg font-semibold mb-3">{t('preferences.title')}</div>
      {loading ? (
        <div className="opacity-70">{t('common.loading')}</div>
      ) : (
        <div className="space-y-4">
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">{t('preferences.currency')}</div>
            <div className="text-xs opacity-70 mb-3">
              {t('preferences.currencyHelp')}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <select
                className="bg-gray-700 rounded px-3 py-2"
                value={currency}
                onChange={(e) =>
                  setCurrency(String(e.target.value || '').toUpperCase())
                }
              >
                <option value="EUR">EUR</option>
                <option value="QAR">QAR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
                <option value="AED">AED</option>
                <option value="ALL">ALL</option>
              </select>
            </div>
          </div>
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">{t('preferences.languages')}</div>
            <div className="text-xs opacity-70 mb-3">
              {t('preferences.languagesHelp')}
            </div>
            <select
              className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
              value={language}
              onChange={(e) =>
                setLanguage(e.target.value === 'sq' ? 'sq' : 'en')
              }
              aria-label={t('preferences.languages')}
            >
              <option value="en">{t('preferences.langEnglish')}</option>
              <option value="sq">{t('preferences.langAlbanian')}</option>
            </select>
          </div>
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">Approvals (anti-theft)</div>
            <div className="text-xs opacity-70 mb-3">
              Require an ADMIN PIN to approve sensitive actions on waiter
              terminals.
            </div>
            <div className="space-y-3">
              <label className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">
                    Require manager PIN for discounts
                  </div>
                  <div className="text-xs opacity-70">
                    Any discount at payment requires approval.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={requireMgrDiscount}
                  onChange={(e) => setRequireMgrDiscount(e.target.checked)}
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Require manager PIN for voids</div>
                  <div className="text-xs opacity-70">
                    Voiding items/tickets requires approval.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={requireMgrVoid}
                  onChange={(e) => setRequireMgrVoid(e.target.checked)}
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">
                    Require manager PIN to remove service charge
                  </div>
                  <div className="text-xs opacity-70">
                    Removing service charge on a ticket requires approval.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={requireMgrServiceRemoval}
                  onChange={(e) =>
                    setRequireMgrServiceRemoval(e.target.checked)
                  }
                />
              </label>
            </div>
          </div>
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">Auto-close waiter shifts</div>
            <div className="text-xs opacity-70 mb-3">
              Automatically close a waiter&apos;s shift if it stays open for too
              long. Shifts are only auto-closed when the waiter has{' '}
              <span className="opacity-90">no open tickets</span> — open tickets
              always block the auto-close.
            </div>
            <label className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-sm">Enable auto-close</div>
                <div className="text-xs opacity-70">
                  Runs in the background every 15 minutes.
                </div>
              </div>
              <input
                type="checkbox"
                checked={autoCloseShiftEnabled}
                onChange={(e) => setAutoCloseShiftEnabled(e.target.checked)}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!autoCloseShiftEnabled}
                onClick={() => setAutoCloseShiftHours(12)}
                className={`px-3 py-2 rounded ${
                  autoCloseShiftHours === 12
                    ? 'bg-blue-600'
                    : 'bg-gray-700 hover:bg-gray-600'
                } ${!autoCloseShiftEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                12 hours
              </button>
              <button
                type="button"
                disabled={!autoCloseShiftEnabled}
                onClick={() => setAutoCloseShiftHours(24)}
                className={`px-3 py-2 rounded ${
                  autoCloseShiftHours === 24
                    ? 'bg-blue-600'
                    : 'bg-gray-700 hover:bg-gray-600'
                } ${!autoCloseShiftEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                24 hours
              </button>
            </div>
          </div>
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">Auto no-show reservations</div>
            <div className="text-xs opacity-70 mb-3">
              Automatically mark a <span className="opacity-90">BOOKED</span>{' '}
              reservation as <span className="opacity-90">NO SHOW</span> after a
              grace period past its start time. Frees the table on the
              reservation floor while keeping the record on the List view. Only
              affects reservations that haven&apos;t been seated, cancelled or
              completed.
            </div>
            <label className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-sm">Enable auto no-show</div>
                <div className="text-xs opacity-70">
                  Runs in the background every minute.
                </div>
              </div>
              <input
                type="checkbox"
                checked={reservationNoShowEnabled}
                onChange={(e) => setReservationNoShowEnabled(e.target.checked)}
              />
            </label>
            <div className="grid grid-cols-3 gap-2 mb-2">
              {[10, 15, 20, 30, 45, 60].map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!reservationNoShowEnabled}
                  onClick={() => setReservationNoShowMinutes(p)}
                  className={`px-3 py-2 rounded text-sm ${
                    reservationNoShowMinutes === p
                      ? 'bg-blue-600'
                      : 'bg-gray-700 hover:bg-gray-600'
                  } ${!reservationNoShowEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {p} min
                </button>
              ))}
            </div>
            <label className="flex items-center justify-between gap-3 mt-2">
              <div className="text-sm">Custom grace (minutes)</div>
              <input
                type="number"
                min={5}
                max={240}
                step={5}
                disabled={!reservationNoShowEnabled}
                value={reservationNoShowMinutes}
                onChange={(e) =>
                  setReservationNoShowMinutes(
                    Math.max(5, Math.min(240, Number(e.target.value) || 0)),
                  )
                }
                className={`w-24 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-right ${!reservationNoShowEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              />
            </label>
            <div className="text-[11px] opacity-60 mt-1">
              Range: 5–240 minutes.
            </div>
          </div>
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">Service charge</div>
            <div className="text-xs opacity-70 mb-3">
              Adds an automatic service charge to the bill. Waiters can remove
              it per ticket.
            </div>

            <label className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-sm">Enable service charge</div>
              </div>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
            </label>

            <div className="grid grid-cols-3 gap-2">
              <button
                className={`px-3 py-2 rounded ${mode === 'PERCENT' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                onClick={() => setMode('PERCENT')}
                type="button"
                disabled={!enabled}
              >
                %
              </button>
              <button
                className={`px-3 py-2 rounded ${mode === 'AMOUNT' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                onClick={() => setMode('AMOUNT')}
                type="button"
                disabled={!enabled}
              >
                Fixed
              </button>
              <input
                className="bg-gray-700 rounded px-3 py-2"
                disabled={!enabled}
                placeholder={mode === 'PERCENT' ? 'e.g. 10' : 'e.g. 5.00'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>

            <button
              className="mt-3 w-full px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800"
              onClick={save}
            >
              Save Preferences
            </button>
            {status && <div className="text-xs opacity-80 mt-2">{status}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function FiscalSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<'easypos'>('easypos');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8080');
  const [authToken, setAuthToken] = useState('');
  const [authTokenConfigured, setAuthTokenConfigured] = useState(false);
  const [integrationApp, setIntegrationApp] = useState('');
  const [defaultOperatorId, setDefaultOperatorId] = useState('');
  const [defaultSoldIn, setDefaultSoldIn] = useState('XPP');
  const [cloudFallbackArticleId, setCloudFallbackArticleId] = useState('');
  const [eurExchangeRate, setEurExchangeRate] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [statusOk, setStatusOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingMinimal, setTestingMinimal] = useState(false);
  const [tokenHint, setTokenHint] = useState<{
    configured: boolean;
    suffix?: string;
    tokenId?: string;
    deviceTail?: string;
  } | null>(null);
  const { t } = useTranslation();

  async function refreshTokenHint() {
    const hint = await window.api.settings
      .getFiscalTokenHint?.()
      .catch(() => null);
    if (hint) setTokenHint(hint);
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        const fiscal = (s as any)?.fiscal || {};
        setEnabled(Boolean(fiscal.enabled));
        setProvider(fiscal.provider === 'easypos' ? 'easypos' : 'easypos');
        setBaseUrl(String(fiscal.baseUrl || 'http://127.0.0.1:8080').trim());
        setAuthTokenConfigured(Boolean(fiscal.authTokenConfigured));
        setAuthToken('');
        setDefaultOperatorId(
          String(fiscal.defaultOperatorId || '').trim() === 'gh537ez200'
            ? 'gh537ez280'
            : String(fiscal.defaultOperatorId || '').trim(),
        );
        setIntegrationApp(String(fiscal.integrationApp || '').trim());
        setDefaultSoldIn(String(fiscal.defaultSoldIn || 'XPP').trim() || 'XPP');
        setCloudFallbackArticleId(
          String(fiscal.cloudFallbackArticleId || '').trim(),
        );
        setEurExchangeRate(
          fiscal.eurExchangeRate != null &&
            Number.isFinite(Number(fiscal.eurExchangeRate))
            ? String(fiscal.eurExchangeRate)
            : '',
        );
      } finally {
        setLoading(false);
      }
      await refreshTokenHint();
    })();
  }, []);

  async function save() {
    setStatus(null);
    setStatusOk(null);
    const url = String(baseUrl || '')
      .trim()
      .replace(/\/+$/g, '');
    const cloud = /api\.(dev\.)?easypos\.al/i.test(url);
    if (enabled && !url) {
      setStatusOk(false);
      setStatus(t('fiscal.baseUrlRequired'));
      return;
    }
    if (enabled && !authToken && !authTokenConfigured) {
      setStatusOk(false);
      setStatus(t('fiscal.authTokenRequired'));
      return;
    }
    if (enabled && cloud && !String(integrationApp || '').trim()) {
      setStatusOk(false);
      setStatus(t('fiscal.integrationAppRequired'));
      return;
    }
    if (enabled && cloud && !String(defaultOperatorId || '').trim()) {
      setStatusOk(false);
      setStatus(t('fiscal.operatorIdRequired'));
      return;
    }
    const op = String(defaultOperatorId || '').trim();
    if (enabled && cloud && op === 'gh537ez200') {
      setStatusOk(false);
      setStatus(t('fiscal.operatorIdTypo'));
      return;
    }
    await window.api.settings.update({
      fiscal: {
        enabled,
        provider,
        baseUrl: url || 'http://127.0.0.1:8080',
        ...(authToken.trim() ? { authToken: authToken.trim() } : {}),
        integrationApp: String(integrationApp || '').trim() || undefined,
        defaultOperatorId: String(defaultOperatorId || '').trim() || undefined,
        defaultSoldIn: String(defaultSoldIn || '').trim() || 'XPP',
        cloudFallbackArticleId:
          String(cloudFallbackArticleId || '').trim() || undefined,
        ...(String(eurExchangeRate || '').trim()
          ? {
              eurExchangeRate: Number(
                String(eurExchangeRate).replace(',', '.'),
              ),
            }
          : {}),
      },
    } as any);
    const latest: any = await window.api.settings.get().catch(() => null);
    setAuthTokenConfigured(Boolean(latest?.fiscal?.authTokenConfigured));
    setAuthToken('');
    setStatusOk(true);
    setStatus(t('fiscal.saved'));
    try {
      window.dispatchEvent(new CustomEvent('pos:settingsChanged'));
    } catch {
      // ignore
    }
    await refreshTokenHint();
  }

  async function testMinimalInvoice() {
    setTestingMinimal(true);
    setStatus(null);
    setStatusOk(null);
    try {
      if (!window.api.settings.testFiscalMinimalInvoice) {
        setStatusOk(false);
        setStatus(t('fiscal.testMinimalUnavailable'));
        return;
      }
      if (authToken.trim()) {
        await window.api.settings.update({
          fiscal: {
            enabled: true,
            provider,
            baseUrl: String(baseUrl || '')
              .trim()
              .replace(/\/+$/g, ''),
            authToken: authToken.trim(),
            integrationApp: String(integrationApp || '').trim() || undefined,
            defaultOperatorId:
              String(defaultOperatorId || '').trim() || undefined,
            defaultSoldIn: String(defaultSoldIn || '').trim() || 'XPP',
            cloudFallbackArticleId:
              String(cloudFallbackArticleId || '').trim() || undefined,
            ...(String(eurExchangeRate || '').trim()
              ? {
                  eurExchangeRate: Number(
                    String(eurExchangeRate).replace(',', '.'),
                  ),
                }
              : {}),
          },
        } as any);
        setAuthTokenConfigured(true);
        setAuthToken('');
        setEnabled(true);
        await refreshTokenHint();
      }
      const r = await window.api.settings.testFiscalMinimalInvoice?.();
      if (r?.ok) {
        setStatusOk(true);
        setStatus(r.message || t('fiscal.testMinimalOk'));
      } else {
        setStatusOk(false);
        setStatus(r?.message || t('fiscal.testMinimalFailed'));
      }
    } catch (e: any) {
      setStatusOk(false);
      setStatus(String(e?.message || t('fiscal.testMinimalFailed')));
    } finally {
      setTestingMinimal(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setStatus(null);
    setStatusOk(null);
    try {
      if (authToken.trim()) {
        await window.api.settings.update({
          fiscal: {
            enabled: true,
            provider,
            baseUrl: String(baseUrl || '')
              .trim()
              .replace(/\/+$/g, ''),
            authToken: authToken.trim(),
            integrationApp: String(integrationApp || '').trim() || undefined,
            defaultOperatorId:
              String(defaultOperatorId || '').trim() || undefined,
            defaultSoldIn: String(defaultSoldIn || '').trim() || 'XPP',
            cloudFallbackArticleId:
              String(cloudFallbackArticleId || '').trim() || undefined,
            ...(String(eurExchangeRate || '').trim()
              ? {
                  eurExchangeRate: Number(
                    String(eurExchangeRate).replace(',', '.'),
                  ),
                }
              : {}),
          },
        } as any);
        setAuthTokenConfigured(true);
        setAuthToken('');
        setEnabled(true);
      } else if (!enabled) {
        await window.api.settings.update({
          fiscal: {
            enabled: true,
            provider,
            baseUrl: String(baseUrl || '')
              .trim()
              .replace(/\/+$/g, ''),
            integrationApp: String(integrationApp || '').trim() || undefined,
            defaultOperatorId:
              String(defaultOperatorId || '').trim() || undefined,
            defaultSoldIn: String(defaultSoldIn || '').trim() || 'XPP',
            cloudFallbackArticleId:
              String(cloudFallbackArticleId || '').trim() || undefined,
            ...(String(eurExchangeRate || '').trim()
              ? {
                  eurExchangeRate: Number(
                    String(eurExchangeRate).replace(',', '.'),
                  ),
                }
              : {}),
          },
        } as any);
        setEnabled(true);
      }
      const r = await window.api.settings.testFiscalConnection?.();
      if (r?.ok) {
        setStatusOk(true);
        const key = r.messageKey ? `fiscal.${r.messageKey}` : null;
        setStatus(
          key && key.startsWith('fiscal.')
            ? t(key as any)
            : r.message || t('fiscal.testOk'),
        );
      } else {
        setStatusOk(false);
        setStatus(r?.message || t('fiscal.testFailed'));
      }
    } catch (e: any) {
      setStatusOk(false);
      setStatus(String(e?.message || t('fiscal.testFailed')));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <div className="text-lg font-semibold mb-3">{t('fiscal.title')}</div>
      {/* Unresolved sales come first — they are money waiting on a decision. */}
      <FiscalReviewPanel />
      {loading ? (
        <div className="opacity-70">{t('common.loading')}</div>
      ) : (
        <div className="space-y-4">
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">{t('fiscal.enableTitle')}</div>
            <div className="text-xs opacity-70 mb-3">
              {t('fiscal.enableHelp')}
            </div>
            <label className="flex items-center justify-between gap-3">
              <div className="text-sm">{t('fiscal.enableLabel')}</div>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
            </label>
          </div>

          <div className="p-3 rounded bg-gray-900/50 border border-gray-700 space-y-3">
            <div className="font-medium mb-1">
              {t('fiscal.middlewareTitle')}
            </div>
            <div className="text-xs opacity-70">
              {t('fiscal.middlewareHelp')}
            </div>

            <label className="block">
              <div className="text-sm mb-1">{t('fiscal.provider')}</div>
              <select
                className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                value={provider}
                onChange={(e) =>
                  setProvider(
                    e.target.value === 'easypos' ? 'easypos' : 'easypos',
                  )
                }
                disabled={!enabled}
              >
                <option value="easypos">easyPos</option>
              </select>
            </label>

            <label className="block">
              <div className="text-sm mb-1">{t('fiscal.baseUrl')}</div>
              <input
                className="bg-gray-700 rounded px-3 py-2 w-full"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.dev.easypos.al/fiscalisation-service/v1"
                disabled={!enabled}
              />
              <div className="text-[11px] opacity-60 mt-1">
                {t('fiscal.baseUrlHelp')}
              </div>
            </label>

            <label className="block">
              <div className="text-sm mb-1">{t('fiscal.authToken')}</div>
              <input
                className="bg-gray-700 rounded px-3 py-2 w-full"
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder={
                  authTokenConfigured
                    ? t('fiscal.authTokenConfigured')
                    : t('fiscal.authTokenPlaceholder')
                }
                disabled={!enabled}
              />
              {authTokenConfigured && !authToken.trim() ? (
                <div className="text-xs text-emerald-400 mt-1">
                  {t('fiscal.authTokenStored')}
                </div>
              ) : null}
              {tokenHint?.configured ? (
                <div className="text-xs opacity-70 mt-1">
                  {t('fiscal.tokenHint', {
                    suffix: tokenHint.suffix || '—',
                    tokenId: tokenHint.tokenId || '—',
                    deviceTail: tokenHint.deviceTail || '—',
                  })}
                </div>
              ) : null}
              <div className="text-[11px] opacity-60 mt-1">
                {t('fiscal.tokenResyncHelp')}
              </div>
            </label>

            <label className="block">
              <div className="text-sm mb-1">{t('fiscal.integrationApp')}</div>
              <input
                className="bg-gray-700 rounded px-3 py-2 w-full"
                value={integrationApp}
                onChange={(e) => setIntegrationApp(e.target.value)}
                placeholder={t('fiscal.integrationAppPlaceholder')}
                disabled={!enabled}
              />
            </label>

            <label className="block">
              <div className="text-sm mb-1">{t('fiscal.operatorId')}</div>
              <input
                className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                value={defaultOperatorId}
                onChange={(e) => setDefaultOperatorId(e.target.value)}
                placeholder={t('fiscal.operatorIdPlaceholder')}
                disabled={!enabled}
              />
              <div className="text-[11px] opacity-60 mt-1">
                {t('fiscal.operatorIdHelp')}
              </div>
            </label>

            <label className="block">
              <div className="text-sm mb-1">{t('fiscal.defaultSoldIn')}</div>
              <input
                className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                value={defaultSoldIn}
                onChange={(e) => setDefaultSoldIn(e.target.value)}
                placeholder="XPP"
                disabled={!enabled}
              />
              <div className="text-[11px] opacity-60 mt-1">
                {t('fiscal.defaultSoldInHelp')}
              </div>
            </label>

            <label className="block">
              <div className="text-sm mb-1">
                {t('fiscal.cloudFallbackArticleId')}
              </div>
              <input
                className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                value={cloudFallbackArticleId}
                onChange={(e) => setCloudFallbackArticleId(e.target.value)}
                placeholder="PROD001"
                disabled={!enabled}
              />
              <div className="text-[11px] opacity-60 mt-1">
                {t('fiscal.cloudFallbackArticleIdHelp')}
              </div>
            </label>

            <label className="block">
              <div className="text-sm mb-1">{t('fiscal.eurExchangeRate')}</div>
              <input
                className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                value={eurExchangeRate}
                onChange={(e) => setEurExchangeRate(e.target.value)}
                placeholder="100.5"
                disabled={!enabled}
              />
              <div className="text-[11px] opacity-60 mt-1">
                {t('fiscal.eurExchangeRateHelp')}
              </div>
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                onClick={() => void testConnection()}
                disabled={!enabled || testing || testingMinimal}
              >
                {testing ? t('fiscal.testing') : t('fiscal.testConnection')}
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                onClick={() => void testMinimalInvoice()}
                disabled={!enabled || testing || testingMinimal}
              >
                {testingMinimal
                  ? t('fiscal.testingMinimal')
                  : t('fiscal.testMinimalInvoice')}
              </button>
            </div>
          </div>

          <button
            className="w-full px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800"
            onClick={() => void save()}
            type="button"
          >
            {t('fiscal.save')}
          </button>
          {status ? (
            <div
              className={`text-xs whitespace-pre-wrap break-words ${
                statusOk === false
                  ? 'text-red-400'
                  : statusOk === true
                    ? 'text-emerald-400'
                    : 'opacity-80'
              }`}
            >
              {status.replace(/ · /g, '\n')}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Payments the POS refused to retry because it could not tell whether
 * easyPos had already registered the invoice.
 *
 * Only an admin looking at easyPos can settle these, so the panel asks
 * exactly one question — is the invoice there or not — and makes the
 * consequence of each answer explicit. Both answers are irreversible in
 * practice: "not there" sends the payment again, "there" records it as
 * done forever.
 */
function FiscalReviewPanel() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FiscalReviewDTO[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nslf, setNslf] = useState('');
  const [nivf, setNivf] = useState('');
  const [status, setStatus] = useState<string>('');

  const supported = Boolean(window.api.settings.listFiscalReviews);

  const load = useCallback(async () => {
    if (!supported) return;
    try {
      setRows((await window.api.settings.listFiscalReviews?.()) ?? []);
    } catch {
      setRows([]);
    }
  }, [supported]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (
    idempotencyKey: string,
    resolution: 'retry' | 'registered' | 'corrected',
  ) => {
    setBusyKey(idempotencyKey);
    setStatus('');
    try {
      const r = await window.api.settings.resolveFiscalReview?.({
        idempotencyKey,
        resolution,
        ...(resolution === 'registered'
          ? { nslf: nslf.trim(), nivf: nivf.trim() }
          : {}),
      });
      setStatus(r?.ok ? t('fiscal.reviewResolved') : t('fiscal.reviewFailed'));
      setExpanded(null);
      setNslf('');
      setNivf('');
      await load();
    } catch (e: any) {
      setStatus(String(e?.message || t('fiscal.reviewFailed')));
    } finally {
      setBusyKey(null);
    }
  };

  // Stay out of the way entirely when there is nothing to reconcile.
  if (!supported || !rows || rows.length === 0) return null;

  return (
    <div className="mb-4 rounded border border-amber-600/60 bg-amber-950/30 p-3">
      <div className="font-medium text-amber-300">
        {t('fiscal.reviewTitle')} ({rows.length})
      </div>
      <div className="text-[11px] opacity-80 mt-1 mb-3">
        {t('fiscal.reviewHelp')}
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const open = expanded === row.idempotencyKey;
          const busy = busyKey === row.idempotencyKey;
          return (
            <div
              key={row.idempotencyKey}
              className="rounded bg-gray-900/60 p-2 text-xs"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">
                  {[row.area, row.tableLabel && `Table ${row.tableLabel}`]
                    .filter(Boolean)
                    .join(' ') || '—'}
                </span>
                <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {row.kind === 'correction-required'
                    ? t('fiscal.reviewKindCorrection')
                    : t('fiscal.reviewKindUnknown')}
                </span>
                {row.total != null ? <span>{row.total.toFixed(2)}</span> : null}
                <span className="opacity-60">
                  {new Date(row.updatedAt).toLocaleString()}
                </span>
                <span className="opacity-60">
                  {t('fiscal.reviewAttempts', { count: row.attempts })}
                </span>
              </div>
              <div className="mt-1 font-mono break-all opacity-80">
                {t('fiscal.reviewDocId')}: {row.idempotencyKey}
              </div>
              {row.nivf || row.nslf ? (
                <div className="mt-1 font-mono break-all opacity-80">
                  {[
                    row.nivf && `${t('fiscal.reviewNivf')}: ${row.nivf}`,
                    row.nslf && `${t('fiscal.reviewNslf')}: ${row.nslf}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              ) : null}
              {row.lastError ? (
                <div className="mt-1 opacity-70 break-words">
                  {row.lastError}
                </div>
              ) : null}

              {/* A correction has one honest answer: file it in easyPos,
                  then say so. Retrying or re-recording makes no sense. */}
              {row.kind === 'correction-required' ? (
                <div className="mt-2 flex flex-col gap-2 border-t border-gray-700 pt-2">
                  <div className="opacity-80">
                    {t('fiscal.reviewCorrectionHelp')}
                  </div>
                  <div>
                    <button
                      type="button"
                      disabled={busy}
                      className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50"
                      onClick={() =>
                        void resolve(row.idempotencyKey, 'corrected')
                      }
                    >
                      {t('fiscal.reviewConfirmCorrected')}
                    </button>
                  </div>
                </div>
              ) : open ? (
                <div className="mt-2 flex flex-col gap-2 border-t border-gray-700 pt-2">
                  <div className="opacity-80">
                    {t('fiscal.reviewFoundHelp')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="flex-1 min-w-[140px]">
                      <div className="mb-1">{t('fiscal.reviewNslf')}</div>
                      <input
                        className="w-full bg-gray-800 rounded px-2 py-1"
                        value={nslf}
                        onChange={(e) => setNslf(e.target.value)}
                      />
                    </label>
                    <label className="flex-1 min-w-[140px]">
                      <div className="mb-1">{t('fiscal.reviewNivf')}</div>
                      <input
                        className="w-full bg-gray-800 rounded px-2 py-1"
                        value={nivf}
                        onChange={(e) => setNivf(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50"
                      onClick={() =>
                        void resolve(row.idempotencyKey, 'registered')
                      }
                    >
                      {t('fiscal.reviewConfirmFound')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                      onClick={() => setExpanded(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                    onClick={() => {
                      setExpanded(row.idempotencyKey);
                      setNslf('');
                      setNivf('');
                    }}
                  >
                    {t('fiscal.reviewFound')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                    title={t('fiscal.reviewNotFoundHelp')}
                    onClick={() => void resolve(row.idempotencyKey, 'retry')}
                  >
                    {t('fiscal.reviewNotFound')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {status ? <div className="mt-2 text-xs opacity-80">{status}</div> : null}
    </div>
  );
}

function BackupsSettings() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<
    Array<{ name: string; bytes: number; createdAt: string }>
  >([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cloudConfigured, setCloudConfigured] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s: any = await window.api.settings.get();
        const url = String(s?.cloud?.backendUrl || '').trim();
        const code = String(s?.cloud?.businessCode || '').trim();
        setCloudConfigured(Boolean(url && code));
      } catch {
        setCloudConfigured(false);
      }
    })();
  }, []);

  async function reload() {
    setLoading(true);
    try {
      const list = await (window.api as any).backups.list();
      setRows(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setStatus(e?.message || 'Failed to load backups');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function fmtBytes(n: number) {
    const b = Number(n || 0);
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Backups</div>
      <div className="text-xs opacity-70 mb-3">
        Backups are stored on this POS computer. Restoring will overwrite the
        current database and restart the app. When cloud is configured, you can
        sync data from the cloud or upload backups to the cloud.
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <button
          className="flex-1 px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60"
          disabled={busy != null}
          onClick={async () => {
            setBusy('create');
            setStatus(null);
            try {
              const r = await (window.api as any).backups.create();
              if (!r?.ok) setStatus(r?.error || 'Backup failed');
              else setStatus('Backup created.');
              await reload();
            } catch (e: any) {
              setStatus(e?.message || 'Backup failed');
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === 'create' ? 'Creating…' : 'Backup now'}
        </button>
        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
          disabled={busy != null}
          onClick={() => void reload()}
        >
          Refresh
        </button>
        {cloudConfigured && (
          <>
            <button
              className="px-3 py-2 rounded bg-violet-700 hover:bg-violet-800 disabled:opacity-60"
              disabled={busy != null}
              onClick={async () => {
                setBusy('sync');
                setStatus(null);
                try {
                  const syncFn = (window.api as any).backups?.syncFromCloud;
                  if (typeof syncFn !== 'function') {
                    setStatus(
                      'Sync not available. Please restart the app and try again.',
                    );
                    return;
                  }
                  const r = await syncFn();
                  if (r?.error) setStatus(r.error);
                  else if (r?.usersSynced === 0 && r?.menuItemsSynced === 0)
                    setStatus('No users or menu in cloud.');
                  else if (!r?.menuSynced)
                    setStatus(
                      `Synced ${r?.usersSynced ?? 0} users. Log in to Cloud (Settings) to sync menu.`,
                    );
                  else
                    setStatus(
                      `Synced ${r?.usersSynced ?? 0} users and ${r?.menuItemsSynced ?? 0} menu items.`,
                    );
                } catch (e: any) {
                  setStatus(e?.message || 'Sync failed');
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync from cloud'}
            </button>
            <button
              className="px-3 py-2 rounded bg-sky-700 hover:bg-sky-800 disabled:opacity-60"
              disabled={busy != null}
              onClick={async () => {
                setBusy('upload');
                setStatus(null);
                try {
                  const r = await (window.api as any).backups.uploadToCloud({});
                  if (!r?.ok) setStatus(r?.error || 'Upload failed');
                  else setStatus('Backup uploaded to cloud.');
                } catch (e: any) {
                  setStatus(e?.message || 'Upload failed');
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'upload' ? 'Uploading…' : 'Upload to cloud'}
            </button>
          </>
        )}
      </div>

      {status && <div className="text-xs opacity-80 mb-3">{status}</div>}

      {loading ? (
        <div className="opacity-70">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="opacity-70 text-sm">No backups yet.</div>
      ) : (
        <div className="divide-y divide-gray-700 border border-gray-700 rounded overflow-hidden">
          {rows.map((b) => (
            <div
              key={b.name}
              className="p-3 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{b.name}</div>
                <div className="text-xs opacity-70">
                  {new Date(b.createdAt).toLocaleString()} · {fmtBytes(b.bytes)}
                </div>
              </div>
              <div className="flex gap-2">
                {cloudConfigured && (
                  <button
                    className="px-3 py-2 rounded bg-sky-700 hover:bg-sky-800 disabled:opacity-60"
                    disabled={busy != null}
                    onClick={async () => {
                      setBusy(`upload:${b.name}`);
                      setStatus(null);
                      try {
                        const r = await (
                          window.api as any
                        ).backups.uploadToCloud({ name: b.name });
                        if (!r?.ok) setStatus(r?.error || 'Upload failed');
                        else setStatus(`Uploaded ${b.name} to cloud.`);
                      } catch (e: any) {
                        setStatus(e?.message || 'Upload failed');
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Upload
                  </button>
                )}
                <button
                  className="px-3 py-2 rounded bg-rose-700 hover:bg-rose-800 disabled:opacity-60"
                  disabled={busy != null}
                  onClick={async () => {
                    const ok = confirm(
                      `Restore backup ${b.name}?\n\nThis will overwrite the current database and restart the app.`,
                    );
                    if (!ok) return;
                    setBusy(`restore:${b.name}`);
                    setStatus(null);
                    try {
                      const r = await (window.api as any).backups.restore({
                        name: b.name,
                      });
                      if (!r?.ok) setStatus(r?.error || 'Restore failed');
                      else if (r?.devRestartRequired)
                        setStatus(
                          'Restored. App will close now (dev mode). Please run "npm run dev" again.',
                        );
                      else setStatus('Restoring…');
                    } catch (e: any) {
                      setStatus(e?.message || 'Restore failed');
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Restore
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GoogleCalendarSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [calendarId, setCalendarId] = useState('primary');
  const [calendarSummary, setCalendarSummary] = useState('');
  const [calendars, setCalendars] = useState<
    Array<{ id: string; summary: string; primary?: boolean }>
  >([]);
  const [syncIntervalMin, setSyncIntervalMin] = useState(5);
  const [defaultArea, setDefaultArea] = useState('');
  const [defaultDurationMin, setDefaultDurationMin] = useState(120);
  const [areas, setAreas] = useState<string[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadSettings = async () => {
    const s: any = await window.api.settings.get();
    const gc = s?.googleCalendar || {};
    setEnabled(Boolean(gc.enabled));
    setOauthConfigured(Boolean(s?.googleCalendarOAuthConfigured));
    setOauthConnected(Boolean(gc.oauthConnected));
    setAccountEmail(String(gc.accountEmail || ''));
    setCalendarId(String(gc.calendarId || 'primary'));
    setCalendarSummary(String(gc.calendarSummary || ''));
    setSyncIntervalMin(Number(gc.syncIntervalMin || 5));
    setDefaultDurationMin(Number(gc.defaultDurationMin || 120));
    setLastSyncAt(gc.lastSyncAt ? String(gc.lastSyncAt) : null);
    setLastSyncMessage(gc.lastSyncMessage ? String(gc.lastSyncMessage) : null);
    setLastSyncError(gc.lastSyncError ? String(gc.lastSyncError) : null);
    const tableAreas = Array.isArray(s?.tableAreas)
      ? s.tableAreas
          .map((a: any) => String(a?.name || '').trim())
          .filter(Boolean)
      : [];
    setAreas(tableAreas);
    setDefaultArea((current) => {
      const saved = String(gc.defaultArea || current || '').trim();
      if (saved && tableAreas.includes(saved)) return saved;
      return tableAreas[0] || '';
    });
    if (gc.oauthConnected) {
      const listed = await window.api.settings.listGoogleCalendars?.();
      if (listed?.ok && Array.isArray(listed.calendars)) {
        setCalendars(listed.calendars);
      }
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!alive) return;
        await loadSettings();
      } catch {
        /* ignore */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const selected = calendars.find((c) => c.id === calendarId);
      const payload: any = {
        googleCalendar: {
          enabled,
          syncIntervalMin,
          defaultArea: defaultArea.trim() || areas[0] || '',
          defaultDurationMin,
          calendarId,
          calendarSummary: selected?.summary || calendarSummary || undefined,
        },
      };
      await window.api.settings.update(payload);
      setStatus(t('googleCalendar.saved'));
      toast.success(t('googleCalendar.saved'));
    } catch (e: any) {
      const msg = String(e?.message || t('googleCalendar.saveFailed'));
      setStatus(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    setConnecting(true);
    setStatus(t('googleCalendar.connecting'));
    try {
      const result = await window.api.settings.connectGoogleCalendar?.();
      if (!result?.ok) {
        throw new Error(
          String(result?.error || t('googleCalendar.connectFailed')),
        );
      }
      setOauthConnected(true);
      setEnabled(true);
      setAccountEmail(String(result.accountEmail || ''));
      setCalendarId(String(result.calendarId || 'primary'));
      setCalendarSummary(String(result.calendarSummary || ''));
      if (Array.isArray(result.calendars)) setCalendars(result.calendars);
      if (result.warning) {
        setLastSyncError(result.warning);
        setStatus(result.warning);
        toast.error(result.warning);
        return;
      }
      setStatus(
        t('googleCalendar.connected', { email: result.accountEmail || '' }),
      );
      toast.success(
        t('googleCalendar.connected', { email: result.accountEmail || '' }),
      );
    } catch (e: any) {
      const msg = String(e?.message || t('googleCalendar.connectFailed'));
      setStatus(msg);
      toast.error(msg);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setConnecting(true);
    setStatus(null);
    try {
      await window.api.settings.disconnectGoogleCalendar?.();
      setOauthConnected(false);
      setAccountEmail('');
      setCalendarSummary('');
      setCalendars([]);
      setStatus(t('googleCalendar.disconnected'));
      toast.success(t('googleCalendar.disconnected'));
    } catch (e: any) {
      const msg = String(e?.message || t('googleCalendar.disconnectFailed'));
      setStatus(msg);
      toast.error(msg);
    } finally {
      setConnecting(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setStatus(null);
    try {
      const result = await window.api.settings.syncGoogleCalendar?.();
      if (!result) throw new Error(t('googleCalendar.syncUnavailable'));
      const refreshed: any = await window.api.settings.get();
      const gc = refreshed?.googleCalendar || {};
      setLastSyncAt(gc.lastSyncAt ? String(gc.lastSyncAt) : null);
      setLastSyncMessage(
        gc.lastSyncMessage ? String(gc.lastSyncMessage) : null,
      );
      setLastSyncError(gc.lastSyncError ? String(gc.lastSyncError) : null);
      if (!result.ok) {
        const msg = String(result.error || t('googleCalendar.syncFailed'));
        setStatus(msg);
        toast.error(msg);
        return;
      }
      const msg = String(
        result.message ||
          t('googleCalendar.syncSuccess', {
            imported: result.imported,
            updated: result.updated,
            cancelled: result.cancelled,
          }),
      );
      setStatus(msg);
      toast.success(msg);
    } catch (e: any) {
      const msg = String(e?.message || t('googleCalendar.syncFailed'));
      setStatus(msg);
      toast.error(msg);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <div className="text-lg font-semibold mb-1">
        {t('googleCalendar.title')}
      </div>
      <div className="text-sm opacity-70 mb-4">
        {t('googleCalendar.subtitle')}
      </div>

      <div className="rounded border border-gray-700 bg-gray-900/40 p-3 text-xs opacity-80 mb-4 whitespace-pre-line">
        {t('googleCalendar.flowHelp')}
      </div>

      {!oauthConfigured && (
        <div className="rounded border border-amber-700/50 bg-amber-950/20 p-3 text-sm text-amber-100 mb-4">
          {t('googleCalendar.oauthNotConfigured')}
        </div>
      )}

      <div className="space-y-4">
        <div className="rounded border border-gray-800 bg-gray-900/30 p-4 space-y-3">
          <div className="font-medium">{t('googleCalendar.accountTitle')}</div>
          {oauthConnected ? (
            <>
              <div className="text-sm">
                <span className="opacity-70">
                  {t('googleCalendar.connectedAs')}
                </span>{' '}
                <span className="font-medium">
                  {accountEmail || 'Google account'}
                </span>
              </div>
              {calendars.length > 0 && (
                <div>
                  <label className="block text-sm mb-1">
                    {t('googleCalendar.calendarPicker')}
                  </label>
                  <select
                    className="bg-gray-700 rounded px-3 py-2 w-full"
                    value={calendarId}
                    onChange={(e) => setCalendarId(e.target.value)}
                    disabled={loading}
                  >
                    {calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.summary}
                        {c.primary ? ` (${t('googleCalendar.primary')})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <button
                type="button"
                className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                onClick={() => void disconnect()}
                disabled={loading || connecting}
              >
                {t('googleCalendar.disconnect')}
              </button>
            </>
          ) : (
            <>
              <div className="text-sm opacity-80">
                {t('googleCalendar.connectHelp')}
              </div>
              <button
                type="button"
                className="px-4 py-2 rounded bg-blue-700 hover:bg-blue-800 disabled:opacity-50"
                onClick={() => void connect()}
                disabled={loading || connecting || !oauthConfigured}
              >
                {connecting
                  ? t('googleCalendar.connecting')
                  : t('googleCalendar.connect')}
              </button>
            </>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={loading || !oauthConnected}
          />
          {t('googleCalendar.enableLabel')}
        </label>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-sm mb-1">
              {t('googleCalendar.syncInterval')}
            </label>
            <input
              type="number"
              min={5}
              max={60}
              className="bg-gray-700 rounded px-3 py-2 w-full"
              value={syncIntervalMin}
              onChange={(e) => setSyncIntervalMin(Number(e.target.value))}
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-sm mb-1">
              {t('googleCalendar.defaultArea')}
            </label>
            <select
              className="bg-gray-700 rounded px-3 py-2 w-full"
              value={defaultArea}
              onChange={(e) => setDefaultArea(e.target.value)}
              disabled={loading}
            >
              {areas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm mb-1">
              {t('googleCalendar.defaultDuration')}
            </label>
            <input
              type="number"
              min={15}
              max={720}
              className="bg-gray-700 rounded px-3 py-2 w-full"
              value={defaultDurationMin}
              onChange={(e) => setDefaultDurationMin(Number(e.target.value))}
              disabled={loading}
            />
          </div>
        </div>

        <div className="rounded border border-gray-800 bg-gray-900/30 p-3">
          <div className="font-medium text-sm mb-2">
            {t('googleCalendar.eventFormatTitle')}
          </div>
          <pre className="text-xs opacity-80 whitespace-pre-wrap font-mono">
            {t('googleCalendar.eventFormatExample')}
          </pre>
        </div>

        {(lastSyncAt || lastSyncMessage || lastSyncError) && (
          <div className="rounded border border-gray-800 bg-gray-900/30 p-3 text-sm space-y-1">
            <div className="font-medium">{t('googleCalendar.lastSync')}</div>
            {lastSyncAt && (
              <div className="opacity-80">
                {new Date(lastSyncAt).toLocaleString()}
              </div>
            )}
            {lastSyncMessage && (
              <div className="text-emerald-300">{lastSyncMessage}</div>
            )}
            {lastSyncError && (
              <div className="text-rose-300">{lastSyncError}</div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50"
            onClick={() => void save()}
            disabled={loading || saving}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
          <button
            className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
            onClick={() => void syncNow()}
            disabled={loading || syncing || !enabled || !oauthConnected}
          >
            {syncing
              ? t('googleCalendar.syncing')
              : t('googleCalendar.syncNow')}
          </button>
        </div>

        {status && <div className="text-sm opacity-80">{status}</div>}
      </div>
    </div>
  );
}

function KdsSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [kdsOn, setKdsOn] = useState(true);
  const [savingMaster, setSavingMaster] = useState(false);
  const [stations, setStations] = useState<Record<KdsStation, boolean>>(() => {
    const init = {} as Record<KdsStation, boolean>;
    for (const st of ALL_KDS_STATIONS) init[st] = true;
    return init;
  });
  const [loadingStations, setLoadingStations] = useState(true);
  const [savingStation, setSavingStation] = useState<KdsStation | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s: any = await window.api.settings.get();
        const map = s?.kds?.stations;
        if (!alive) return;
        setKdsOn(s?.kds?.enabled !== false);
        setStations((prev) => {
          const next = { ...prev };
          for (const st of ALL_KDS_STATIONS) {
            next[st] = !map || map[st] !== false;
          }
          return next;
        });
      } catch {
        /* keep defaults (all enabled) */
      } finally {
        if (alive) setLoadingStations(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggleMaster = async () => {
    const next = !kdsOn;
    setKdsOn(next);
    setSavingMaster(true);
    setStatus(null);
    try {
      await window.api.settings.update({ kds: { enabled: next } } as any);
      setStatus(next ? t('kdsSettings.masterOn') : t('kdsSettings.masterOff'));
    } catch {
      setKdsOn(!next);
      setStatus(t('kdsSettings.masterSaveFailed'));
    } finally {
      setSavingMaster(false);
    }
  };

  const toggleStation = async (station: KdsStation) => {
    const next = { ...stations, [station]: !stations[station] };
    setStations(next);
    setSavingStation(station);
    setStatus(null);
    try {
      await window.api.settings.update({ kds: { stations: next } });
      setStatus(
        next[station]
          ? `${kdsStationLabel(station)} enabled — orders now route here.`
          : `${kdsStationLabel(station)} disabled — orders no longer route here.`,
      );
    } catch {
      // Roll back on failure.
      setStations((prev) => ({ ...prev, [station]: !next[station] }));
      setStatus(`Could not save ${kdsStationLabel(station)}.`);
    } finally {
      setSavingStation(null);
    }
  };

  return (
    <div>
      <div className="text-lg font-semibold mb-3">{t('kdsSettings.title')}</div>
      <div className="space-y-3">
        <div className="rounded border border-gray-700 bg-gray-900/40 p-3 text-xs opacity-80">
          KDS app updates are installed on each kitchen screen (not from this
          POS admin panel). When a new KDS version is published, the kitchen app
          shows a download prompt — use Install &amp; Restart there, same as POS
          updates under System Updates.
        </div>
        <div className="text-xs opacity-70">
          On each kitchen screen, open the KDS Settings tab (or press{' '}
          <span className="font-mono">J</span> on the bump bar) to choose{' '}
          {kdsStationLabel('KITCHEN')}, {kdsStationLabel('BAR')}, or{' '}
          {kdsStationLabel('DESSERT')} for that display.
        </div>

        <label className="flex items-center justify-between gap-3 rounded border border-gray-800 bg-gray-900/40 px-3 py-3">
          <div>
            <div className="text-sm font-medium">
              {t('kdsSettings.masterLabel')}
            </div>
            <div className="text-xs opacity-70 mt-1">
              {t('kdsSettings.masterHelp')}
            </div>
          </div>
          <button
            type="button"
            disabled={loadingStations || savingMaster}
            onClick={() => void toggleMaster()}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              kdsOn ? 'bg-emerald-600' : 'bg-gray-600'
            }`}
            aria-pressed={kdsOn}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                kdsOn ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>

        <div className="mt-4 pt-4 border-t border-gray-800">
          <div className="font-medium mb-1">
            {t('kdsSettings.stationsTitle')}
          </div>
          <div className="text-xs opacity-70 mb-3">
            {t('kdsSettings.stationsHelp')}
          </div>
          <div className={`space-y-2 ${kdsOn ? '' : 'opacity-50'}`}>
            {ALL_KDS_STATIONS.map((st) => (
              <label
                key={st}
                className="flex items-center justify-between gap-3 rounded border border-gray-800 bg-gray-900/40 px-3 py-2"
              >
                <span className="text-sm">{kdsStationLabel(st)}</span>
                <button
                  type="button"
                  disabled={!kdsOn || loadingStations || savingStation === st}
                  onClick={() => toggleStation(st)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    stations[st] ? 'bg-emerald-600' : 'bg-gray-600'
                  }`}
                  aria-pressed={stations[st]}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      stations[st] ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            ))}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-800">
          <div className="font-medium mb-1">Bump bar programming</div>
          <div className="text-xs opacity-70 mb-3">
            Program each physical key in PrehKeyTec WinProgrammer (or MapMyKey)
            to send the keystroke below. USB plug-and-play — no driver needed on
            the KDS PC.
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left opacity-70 border-b border-gray-800">
                  <th className="py-1 pr-3">Button</th>
                  <th className="py-1 pr-3">Keystroke</th>
                  <th className="py-1">Action</th>
                </tr>
              </thead>
              <tbody>
                {KDS_BUMP_BAR_PROGRAMMING.map((row) => (
                  <tr key={row.button} className="border-b border-gray-900/80">
                    <td className="py-1.5 pr-3 font-medium">{row.button}</td>
                    <td className="py-1.5 pr-3 font-mono">{row.keystroke}</td>
                    <td className="py-1.5 opacity-80">{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 w-full disabled:opacity-50"
          disabled={!kdsOn}
          onClick={async () => {
            setStatus(null);
            await window.api.kds.openWindow();
          }}
        >
          {t('kdsSettings.openWindow')}
        </button>
        {!kdsOn && (
          <div className="text-xs opacity-70">
            {t('kdsSettings.openWindowDisabled')}
          </div>
        )}

        {status && <div className="text-xs opacity-80">{status}</div>}
      </div>
    </div>
  );
}

function AddRouteModal({
  availableCategories,
  enabledProfiles,
  routingEnabled,
  onAdd,
  onClose,
}: {
  availableCategories: Array<{ id: number; name: string }>;
  enabledProfiles: Array<{ id: string; name: string; mode?: string }>;
  routingEnabled: boolean;
  onAdd: (catId: string, printerId: string) => void;
  onClose: () => void;
}) {
  const [catId, setCatId] = useState('');
  const [printerId, setPrinterId] = useState('default');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close modal"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between gap-3">
          <div className="font-semibold">Add category route</div>
          <button
            type="button"
            className="w-9 h-9 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center"
            onClick={onClose}
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="pos-icon"
            >
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-4">
          <label className="block text-sm">
            <div className="opacity-80 mb-1">Category</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={catId}
              onChange={(e) => setCatId(String(e.target.value || ''))}
              disabled={!routingEnabled}
            >
              <option value="">Select category…</option>
              {availableCategories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <div className="opacity-80 mb-1">Printer</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={printerId}
              onChange={(e) =>
                setPrinterId(String(e.target.value || 'default'))
              }
              disabled={!routingEnabled}
            >
              {enabledProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.mode || 'NETWORK'})
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 pt-2">
            <button
              className="flex-1 px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60"
              type="button"
              disabled={!routingEnabled || !catId}
              onClick={() => onAdd(catId, printerId)}
            >
              Add route
            </button>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type PrinterProfile = {
  id: string;
  name: string;
  enabled?: boolean;
  mode?: 'NETWORK' | 'SYSTEM' | 'SERIAL';
  ip?: string;
  port?: number;
  deviceName?: string;
  silent?: boolean;
  systemRawEscpos?: boolean;
  serialPath?: string;
  baudRate?: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  paperWidthMm?: 58 | 80;
};

function PrinterSettings() {
  type Profile = PrinterProfile;

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [receiptPrinterId, setReceiptPrinterId] = useState<string>('default');
  // Single fallback printer for ORDER items that don't match a category route.
  const [fallbackPrinterId, setFallbackPrinterId] = useState<string>('default');
  // Category routing (optional). Key is categoryId string (e.g. "12") for stability.
  const [categoryRouting, setCategoryRouting] = useState<
    Record<string, string>
  >({});
  const [menuCategories, setMenuCategories] = useState<
    Array<{ id: number; name: string }>
  >([]);
  const [showAddRouteModal, setShowAddRouteModal] = useState(false);

  const [printers, setPrinters] = useState<
    { name: string; isDefault?: boolean }[]
  >([]);
  const [serialPorts, setSerialPorts] = useState<
    { path: string; manufacturer?: string }[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const ensureProfile = (p: any, idx: number): Profile => {
    // CORRECTNESS: previously used Math.random() which produced a different id
    // on every render — that broke React keys and re-mounted list rows on
    // every save/transform, dropping focus and causing reconciliation churn.
    const id = String(p?.id || `p${idx}`);
    const mode: any =
      p?.mode ||
      (p?.serialPath ? 'SERIAL' : p?.deviceName ? 'SYSTEM' : 'NETWORK');
    return {
      id,
      name: String(p?.name || `Printer ${idx + 1}`),
      enabled: p?.enabled !== false,
      mode:
        mode === 'SYSTEM' ? 'SYSTEM' : mode === 'SERIAL' ? 'SERIAL' : 'NETWORK',
      ip: p?.ip ? String(p.ip) : '',
      port: Number(p?.port || 9100),
      deviceName: p?.deviceName ? String(p.deviceName) : '',
      silent: p?.silent !== false,
      systemRawEscpos: p?.systemRawEscpos !== false,
      serialPath: p?.serialPath ? String(p.serialPath) : '',
      baudRate: Number(p?.baudRate || 19200),
      dataBits: (Number(p?.dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
      stopBits: (Number(p?.stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
      parity: String(p?.parity || 'none') as any as 'none' | 'even' | 'odd',
      paperWidthMm: Number(p?.paperWidthMm) === 58 ? 58 : 80,
    };
  };

  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();

      const legacy: any = (s as any)?.printer || {};
      const arr: any[] =
        Array.isArray((s as any)?.printers) && (s as any).printers.length
          ? (s as any).printers
          : legacy && Object.keys(legacy).length
            ? [
                {
                  id: 'default',
                  name: 'Default printer',
                  enabled: true,
                  ...legacy,
                },
              ]
            : [];
      setProfiles(arr.map((p, idx) => ensureProfile(p, idx)));

      const r: any = (s as any)?.printerRouting || {};
      setRoutingEnabled(Boolean(r?.enabled));
      setReceiptPrinterId(String(r?.receiptPrinterId || 'default'));
      setFallbackPrinterId(
        String(r?.fallbackPrinterId || r?.station?.ALL || 'default'),
      );
      // Category routing: allow routing by the *actual* menu categories.
      // Storage format: mapping of categoryId (string) -> printerProfileId.
      const rawCats = (await window.api.menu
        .listCategoriesWithItems()
        .catch(() => [] as any[])) as any[];
      const cats = (Array.isArray(rawCats) ? rawCats : []).map((c: any) => ({
        id: Number(c?.id || 0),
        name: String(c?.name || '').trim(),
      }));
      setMenuCategories(cats.filter((c) => c.id > 0 && c.name));
      const norm = (x: any) =>
        String(x ?? '')
          .trim()
          .toLowerCase();
      const nameToId = new Map<string, number>();
      for (const c of cats) {
        if (c.id > 0 && c.name) nameToId.set(norm(c.name), c.id);
      }
      const rawCatMap: Record<string, string> = (r?.categories || {}) as any;
      const next: Record<string, string> = {};
      for (const [k0, v0] of Object.entries(rawCatMap || {})) {
        const k = String(k0 || '').trim();
        const v = String(v0 || '').trim();
        if (!v) continue;
        // Prefer stable id keys.
        if (/^\d+$/.test(k)) {
          next[k] = v;
          continue;
        }
        // Backward compat: name-based keys (normalized) -> map to id.
        const id = nameToId.get(norm(k));
        if (id) {
          next[String(id)] = v;
          continue;
        }
        // Unknown key: keep it (but UI will show it as unknown).
        next[k] = v;
      }
      setCategoryRouting(next);

      try {
        const list =
          (await (window.api.settings as any).listPrinters?.()) || [];
        setPrinters(list);
      } catch {
        // ignore
      }
      try {
        const list =
          (await (window.api.settings as any).listSerialPorts?.()) || [];
        setSerialPorts(list);
      } catch {
        setStatus('Serial ports unavailable. Run: pnpm run serial:rebuild');
      }
    })();
  }, []);

  const enabledProfiles = profiles.filter((p) => p.enabled !== false);
  const pickOptions = (includeEmpty = true) => (
    <>
      {includeEmpty && <option value="">(not set)</option>}
      {enabledProfiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.mode})
        </option>
      ))}
    </>
  );

  const categoryNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of menuCategories) m.set(Number(c.id), String(c.name || ''));
    return m;
  }, [menuCategories]);

  const routedEntries = useMemo(() => {
    const out: Array<{
      key: string;
      categoryId: number | null;
      label: string;
      printerId: string;
    }> = [];
    for (const [k, v] of Object.entries(categoryRouting || {})) {
      const printerId = String(v || '').trim();
      if (!printerId) continue;
      const categoryId = /^\d+$/.test(k) ? Number(k) : null;
      const label =
        categoryId != null
          ? categoryNameById.get(categoryId) ||
            `Category #${categoryId} (missing)`
          : `Category key: ${k}`;
      out.push({ key: k, categoryId, label, printerId });
    }
    // stable order: known categories first, then unknown keys
    out.sort((a, b) => {
      const ak = a.categoryId == null ? 9 : 0;
      const bk = b.categoryId == null ? 9 : 0;
      if (ak !== bk) return ak - bk;
      return a.label.localeCompare(b.label);
    });
    return out;
  }, [categoryRouting, categoryNameById]);

  const availableCategoriesToAdd = useMemo(() => {
    const used = new Set<string>();
    for (const k of Object.keys(categoryRouting || {})) {
      if (/^\d+$/.test(k)) used.add(String(k));
    }
    return menuCategories.filter((c) => c.id > 0 && !used.has(String(c.id)));
  }, [menuCategories, categoryRouting]);

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Printers</div>

      {status && <div className="text-xs text-amber-200 mb-3">{status}</div>}
      <div className="bg-gray-800/40 border border-gray-700 rounded p-3 mb-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold mb-2">Routing</div>
          <button
            className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-sm mb-3"
            type="button"
            disabled={!routingEnabled}
            onClick={() => setShowAddRouteModal(true)}
          >
            + Add route
          </button>
        </div>
        <div className="text-xs opacity-70 mb-3">
          Enable routing and optionally route categories to specific printers.
          Categories not routed will print to the fallback printer.
        </div>

        <label className="flex items-center justify-between gap-3 mb-3">
          <div className="text-sm">Enable routing (by category)</div>
          <input
            type="checkbox"
            checked={routingEnabled}
            onChange={(e) => setRoutingEnabled(e.target.checked)}
          />
        </label>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
          <label className="text-sm">
            <div className="opacity-80 mb-1">Receipt printer (PAYMENT)</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={receiptPrinterId}
              onChange={(e) => setReceiptPrinterId(e.target.value)}
              disabled={!routingEnabled}
            >
              {pickOptions(false)}
            </select>
          </label>
          <label className="text-sm">
            <div className="opacity-80 mb-1">Fallback printer (ORDER)</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={fallbackPrinterId}
              onChange={(e) => setFallbackPrinterId(e.target.value)}
              disabled={!routingEnabled}
            >
              {pickOptions(false)}
            </select>
          </label>
        </div>

        {routedEntries.length === 0 ? (
          <div className="text-xs opacity-70">
            No category routes yet. Station routing will be used.
          </div>
        ) : (
          <div className="divide-y divide-gray-700 border border-gray-700 rounded overflow-hidden">
            {routedEntries.map((r) => (
              <div key={r.key} className="p-3 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{r.label}</div>
                  {r.categoryId == null && (
                    <div className="text-xs opacity-60">
                      Unknown key stored in settings. You can remove it if not
                      needed.
                    </div>
                  )}
                </div>
                <select
                  className="bg-gray-700 rounded px-3 py-2"
                  value={r.printerId}
                  disabled={!routingEnabled}
                  onChange={(e) =>
                    setCategoryRouting((m) => ({
                      ...(m || {}),
                      [r.key]: String(e.target.value || ''),
                    }))
                  }
                >
                  {pickOptions(false)}
                </select>
                <button
                  className="w-10 h-10 rounded bg-rose-700 hover:bg-rose-800 active:bg-rose-900 flex items-center justify-center"
                  type="button"
                  disabled={!routingEnabled}
                  aria-label={`Remove route for ${r.label}`}
                  onClick={() =>
                    setCategoryRouting((m) => {
                      const next = { ...(m || {}) } as any;
                      delete next[r.key];
                      return next;
                    })
                  }
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="pos-icon"
                    aria-hidden
                  >
                    <path
                      d="M6 6l12 12M18 6 6 18"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAddRouteModal && (
        <AddRouteModal
          availableCategories={availableCategoriesToAdd}
          enabledProfiles={enabledProfiles}
          routingEnabled={routingEnabled}
          onAdd={(catId, printerId) => {
            const cid = String(catId || '').trim();
            if (!cid) return;
            setCategoryRouting((m) => ({
              ...(m || {}),
              [cid]: String(printerId || 'default'),
            }));
            setShowAddRouteModal(false);
          }}
          onClose={() => setShowAddRouteModal(false)}
        />
      )}

      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Printer profiles</div>
        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
          onClick={() =>
            setProfiles((arr) => [
              ...arr,
              ensureProfile(
                {
                  name: `Printer ${arr.length + 1}`,
                  enabled: true,
                  mode: 'NETWORK',
                },
                arr.length,
              ),
            ])
          }
        >
          + Add printer
        </button>
      </div>

      <div className="space-y-2">
        {profiles.map((p) => (
          <PrinterProfileCard
            key={p.id}
            profile={p}
            printers={printers}
            serialPorts={serialPorts}
            onUpdate={(patch) =>
              setProfiles((arr) =>
                arr.map((x) => (x.id === p.id ? { ...x, ...patch } : x)),
              )
            }
            onDelete={() =>
              setProfiles((arr) => arr.filter((x) => x.id !== p.id))
            }
            onRefreshPrinters={async () => {
              const list =
                (await (window.api.settings as any).listPrinters?.()) || [];
              setPrinters(list);
            }}
            onRefreshSerial={async () => {
              try {
                const list =
                  (await (window.api.settings as any).listSerialPorts?.()) ||
                  [];
                setSerialPorts(list);
                if (!list.length) setStatus('No serial ports found.');
              } catch (e: any) {
                setStatus(String(e?.message || 'Serial ports unavailable.'));
              }
            }}
          />
        ))}
      </div>

      <button
        className="mt-4 px-3 py-2 rounded bg-emerald-700 w-full disabled:opacity-60"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          setStatus(null);
          try {
            await window.api.settings.update({
              printers: profiles,
              printerRouting: {
                enabled: routingEnabled,
                receiptPrinterId,
                // Keep backward compat: store fallback printer under station.ALL too.
                station: { ALL: fallbackPrinterId || undefined },
                fallbackPrinterId: fallbackPrinterId || undefined,
                // Store category routing by categoryId string for stability.
                categories: categoryRouting,
              },
            } as any);
            setStatus('Saved printer profiles + routing.');
          } catch (e: any) {
            setStatus(String(e?.message || 'Save failed'));
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? 'Saving…' : 'Save Printers'}
      </button>
    </div>
  );
}

function PrinterProfileCard({
  profile: p,
  printers,
  serialPorts,
  onUpdate,
  onDelete,
  onRefreshPrinters,
  onRefreshSerial,
}: {
  profile: PrinterProfile;
  printers: { name: string; isDefault?: boolean }[];
  serialPorts: { path: string; manufacturer?: string }[];
  onUpdate: (patch: Partial<PrinterProfile>) => void;
  onDelete: () => void;
  onRefreshPrinters: () => Promise<void>;
  onRefreshSerial: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  // Local test-print feedback. We deliberately keep it in the card (not the
  // parent) so each profile has its own independent status line.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<NetworkPrinterDTO[]>([]);

  async function runTestPrint() {
    setTesting(true);
    setTestResult(null);
    try {
      const fn = (window.api.settings as any).testPrintProfile as
        | ((
            profile: PrinterProfile,
          ) => Promise<{ ok: boolean; error?: string }>)
        | undefined;
      if (typeof fn !== 'function') {
        setTestResult({
          ok: false,
          msg: 'Test-print not available in this build. Restart the app after upgrading.',
        });
        return;
      }
      const r = await fn(p);
      if (r?.ok) {
        setTestResult({
          ok: true,
          msg: 'Test page sent — check the printer.',
        });
      } else {
        setTestResult({
          ok: false,
          msg: r?.error || 'Test print failed.',
        });
      }
    } catch (e: any) {
      setTestResult({
        ok: false,
        msg: String(e?.message || e || 'Test print failed.'),
      });
    } finally {
      setTesting(false);
    }
  }

  async function runNetworkScan() {
    setScanning(true);
    setScanHint(null);
    try {
      const fn = window.api.settings.scanNetworkPrinters;
      if (typeof fn !== 'function') {
        setScanHint(
          'Network scan is not available in this build. Restart the app after upgrading.',
        );
        return;
      }
      const list = (await fn()) || [];
      setDiscovered(list);
      if (list.length === 0) {
        setScanHint(
          'No printers answered on this network. Check it is powered on and on the same Wi-Fi, or type the IP below.',
        );
        return;
      }
      setScanHint(
        list.length === 1
          ? 'Found 1 printer. Select it from the list.'
          : `Found ${list.length} printers. Select one from the list.`,
      );
      // One hit and this profile has no address yet — pick it so the
      // admin does not have to open the dropdown for a single device.
      if (list.length === 1 && !String(p.ip || '').trim()) {
        applyDiscovered(list[0]);
      }
    } catch (e: any) {
      setScanHint(String(e?.message || e || 'Scan failed.'));
    } finally {
      setScanning(false);
    }
  }

  function applyDiscovered(hit: NetworkPrinterDTO) {
    const genericName =
      !p.name || /^(Default printer|Printer \d+)$/i.test(p.name);
    onUpdate({
      ip: hit.ip,
      port: hit.port,
      ...(genericName && hit.source === 'mdns' && hit.name
        ? { name: hit.name }
        : {}),
    });
  }

  const selectedKey = p.ip
    ? `${String(p.ip).trim()}:${Number(p.port || 9100)}`
    : '';
  const dropdownOptions = (() => {
    const rows = [...discovered];
    if (
      p.ip &&
      !rows.some(
        (d) =>
          d.ip === String(p.ip).trim() && d.port === Number(p.port || 9100),
      )
    ) {
      rows.unshift({
        ip: String(p.ip).trim(),
        port: Number(p.port || 9100),
        name: `${p.name || 'Current'} (${p.ip}:${p.port || 9100})`,
        source: 'tcp',
      });
    }
    return rows;
  })();
  const mode = p.mode || 'NETWORK';
  const modeLabel =
    mode === 'NETWORK' ? 'Network' : mode === 'SYSTEM' ? 'USB' : 'Serial';
  const connectionDetail =
    mode === 'NETWORK'
      ? `${p.ip || '—'}:${p.port || 9100}`
      : mode === 'SYSTEM'
        ? p.deviceName || '(default printer)'
        : p.serialPath || '(none)';

  return (
    <div className="border border-gray-700 rounded bg-gray-900/30 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-800/40 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className="transition-transform duration-150"
          style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
        >
          <ChevronRight />
        </span>

        <span className="font-semibold truncate flex-1">{p.name}</span>

        <span className="text-[11px] px-2 py-0.5 rounded bg-gray-700 font-medium">
          {modeLabel}
        </span>

        <span
          className={`text-[11px] px-2 py-0.5 rounded font-medium ${
            p.enabled !== false
              ? 'bg-emerald-700/40 text-emerald-300'
              : 'bg-gray-700 text-gray-400'
          }`}
        >
          {p.enabled !== false ? 'Enabled' : 'Disabled'}
        </span>
      </button>

      <div className="px-3 pb-1 -mt-1 text-[11px] text-gray-500 flex items-center gap-2">
        <span>ID: {p.id}</span>
        <span className="opacity-40">·</span>
        <span className="truncate">{connectionDetail}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-2 space-y-3 border-t border-gray-700/50 mt-1">
          <div className="flex items-center gap-2">
            <input
              className="bg-gray-700 rounded px-3 py-2 flex-1"
              placeholder="Printer name"
              value={p.name}
              onChange={(e) => onUpdate({ name: e.target.value })}
            />
            <label className="text-sm flex items-center gap-2 whitespace-nowrap">
              <input
                type="checkbox"
                checked={p.enabled !== false}
                onChange={(e) => onUpdate({ enabled: e.target.checked })}
              />
              Enabled
            </label>
            <button
              className="px-2 py-2 rounded bg-rose-700 hover:bg-rose-800"
              onClick={onDelete}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                className="pos-icon"
                aria-hidden
              >
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <select
            className="bg-gray-700 rounded px-3 py-2 w-full"
            value={mode}
            onChange={(e) => onUpdate({ mode: e.target.value as any })}
          >
            <option value="NETWORK">Network (ESC/POS)</option>
            <option value="SYSTEM">USB / System printer</option>
            <option value="SERIAL">Serial (ESC/POS / many Bluetooth)</option>
          </select>

          <label className="flex items-center gap-2 text-sm">
            Paper width
            <select
              className="bg-gray-700 rounded px-3 py-2 flex-1"
              value={p.paperWidthMm === 58 ? 58 : 80}
              onChange={(e) =>
                onUpdate({
                  paperWidthMm: Number(e.target.value) === 58 ? 58 : 80,
                })
              }
            >
              <option value={80}>80 mm (full-width receipt)</option>
              <option value={58}>58 mm (narrow roll)</option>
            </select>
          </label>

          {mode === 'NETWORK' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <select
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  value={selectedKey}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) {
                      onUpdate({ ip: '', port: 9100 });
                      return;
                    }
                    const [ip, portStr] = v.split(':');
                    const hit =
                      discovered.find((d) => `${d.ip}:${d.port}` === v) ||
                      ({
                        ip,
                        port: Number(portStr || 9100),
                        name: '',
                        source: 'tcp' as const,
                      } satisfies NetworkPrinterDTO);
                    applyDiscovered(hit);
                  }}
                >
                  <option value="">
                    {scanning ? 'Scanning…' : 'Select a printer…'}
                  </option>
                  {dropdownOptions.map((d) => (
                    <option
                      key={`${d.ip}:${d.port}`}
                      value={`${d.ip}:${d.port}`}
                    >
                      {d.name} — {d.ip}:{d.port}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 whitespace-nowrap"
                  disabled={scanning}
                  onClick={() => void runNetworkScan()}
                >
                  {scanning ? 'Scanning…' : 'Scan'}
                </button>
              </div>
              <div className="text-xs opacity-70">
                Scan finds receipt printers on this LAN (raw port 9100). If
                yours is missing, type the address below.
              </div>
              {scanHint ? (
                <div className="text-xs text-amber-200">{scanHint}</div>
              ) : null}
              <div className="flex items-center gap-2">
                <input
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  placeholder="Printer IP (e.g. 192.168.1.50)"
                  value={p.ip || ''}
                  onChange={(e) => onUpdate({ ip: e.target.value })}
                />
                <input
                  className="w-28 bg-gray-700 rounded px-3 py-2"
                  type="number"
                  min={1}
                  value={Number(p.port || 9100)}
                  onChange={(e) => onUpdate({ port: Number(e.target.value) })}
                />
              </div>
            </div>
          )}

          {mode === 'SYSTEM' && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <select
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  value={p.deviceName || ''}
                  onChange={(e) => onUpdate({ deviceName: e.target.value })}
                >
                  <option value="">(default printer)</option>
                  {printers.map((sp) => (
                    <option key={sp.name} value={sp.name}>
                      {sp.name}
                      {sp.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
                  onClick={() => onRefreshPrinters()}
                >
                  Refresh
                </button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={p.silent !== false}
                  onChange={(e) => onUpdate({ silent: e.target.checked })}
                />
                Silent print (no OS dialog)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={p.systemRawEscpos !== false}
                  onChange={(e) =>
                    onUpdate({ systemRawEscpos: e.target.checked })
                  }
                />
                Send raw ESC/POS (recommended for receipt printers)
              </label>
            </div>
          )}

          {mode === 'SERIAL' && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <select
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  value={p.serialPath || ''}
                  onChange={(e) => onUpdate({ serialPath: e.target.value })}
                >
                  <option value="">Select serial port…</option>
                  {serialPorts.map((sp) => (
                    <option key={sp.path} value={sp.path}>
                      {sp.path}
                      {sp.manufacturer ? ` (${sp.manufacturer})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
                  onClick={() => onRefreshSerial()}
                >
                  Refresh
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="bg-gray-700 rounded px-3 py-2"
                  type="number"
                  min={1200}
                  placeholder="Baud rate"
                  value={Number(p.baudRate || 19200)}
                  onChange={(e) =>
                    onUpdate({ baudRate: Number(e.target.value) })
                  }
                />
                <select
                  className="bg-gray-700 rounded px-3 py-2"
                  value={p.parity || 'none'}
                  onChange={(e) => onUpdate({ parity: e.target.value as any })}
                >
                  <option value="none">Parity: none</option>
                  <option value="even">Parity: even</option>
                  <option value="odd">Parity: odd</option>
                </select>
                <select
                  className="bg-gray-700 rounded px-3 py-2"
                  value={p.dataBits || 8}
                  onChange={(e) =>
                    onUpdate({ dataBits: Number(e.target.value) as any })
                  }
                >
                  <option value={8}>Data: 8</option>
                  <option value={7}>Data: 7</option>
                </select>
                <select
                  className="bg-gray-700 rounded px-3 py-2"
                  value={p.stopBits || 1}
                  onChange={(e) =>
                    onUpdate({ stopBits: Number(e.target.value) as any })
                  }
                >
                  <option value={1}>Stop: 1</option>
                  <option value={2}>Stop: 2</option>
                </select>
              </div>
              <div className="text-xs opacity-70">
                Typical Epson: 19200, none, 8, 1.
              </div>
            </div>
          )}

          {/* Test print: sends a "Hello, world!" ESC/POS slip directly to the
              CURRENT (in-memory) profile so admins can validate config
              before saving. Disabled when the profile lacks a destination. */}
          <div className="pt-2 border-t border-gray-700/50">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={
                  testing ||
                  (mode === 'NETWORK' && !p.ip) ||
                  (mode === 'SERIAL' && !p.serialPath)
                }
                className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm font-semibold disabled:opacity-50"
                onClick={runTestPrint}
              >
                {testing ? 'Printing…' : 'Test print'}
              </button>
              <span className="text-[11px] opacity-60">
                Sends a Hello-World slip with the values currently shown above
                (no save needed).
              </span>
            </div>
            {testResult && (
              <div
                className={`mt-2 text-xs ${
                  testResult.ok ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {testResult.msg}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AreasSettings() {
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const [editingArea, setEditingArea] = useState<{
    name: string;
    count: number;
  } | null>(null);
  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();
      setAreas(s.tableAreas || []);
    })();
  }, []);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-lg font-semibold">Table Areas</div>
        <button
          className="text-blue-500 cursor-pointer"
          onClick={() =>
            setAreas((arr) => [...arr, { name: 'New Area', count: 4 }])
          }
        >
          +
        </button>
      </div>

      <div className="text-xs opacity-70 mb-3">
        The floor layout is shared across every waiter and host device. Use{' '}
        <span className="text-emerald-300">Edit layout</span> to arrange tables
        and shapes — your changes appear instantly on every connected device.
      </div>

      <div className="space-y-2">
        {areas.map((a, idx) => (
          <div key={idx} className="flex items-center gap-3 flex-wrap">
            <input
              className="bg-gray-700 rounded px-3 py-2 flex-1 min-w-0"
              value={a.name}
              onChange={(e) =>
                setAreas((arr) =>
                  arr.map((x, i) =>
                    i === idx ? { ...x, name: e.target.value } : x,
                  ),
                )
              }
            />
            <button
              className="px-3 py-2 rounded bg-blue-700 hover:bg-blue-600 text-sm whitespace-nowrap"
              type="button"
              onClick={() => {
                if (!a.name) {
                  toast.error(
                    'Name the area first, then save it, before editing the layout.',
                  );
                  return;
                }
                setEditingArea({ name: a.name, count: a.count });
              }}
            >
              Edit layout
            </button>
            <button
              className="w-10 h-10 rounded bg-rose-700 hover:bg-rose-800 active:bg-rose-900 flex items-center justify-center"
              onClick={() => setAreas((arr) => arr.filter((_, i) => i !== idx))}
              type="button"
              aria-label={`Remove area ${a.name || idx + 1}`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                className="pos-icon"
                aria-hidden
              >
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ))}
        <div>
          <button
            className="mt-2 px-3 py-2 rounded bg-emerald-700 w-full"
            onClick={async () => {
              await window.api.settings.update({ tableAreas: areas });
              toast.success('Table areas saved.');
            }}
          >
            Save Areas
          </button>
        </div>
      </div>

      {editingArea && (
        <AreaLayoutEditorModal
          area={editingArea.name}
          defaultCount={editingArea.count || 8}
          onClose={() => setEditingArea(null)}
        />
      )}
    </div>
  );
}

// Modal that hosts the FloorCanvas in editable mode for a single area.
// The canvas writes to the shared `layout:global:<area>` key on the
// server; every other connected client receives a `layout:changed`
// broadcast and refetches automatically — see `broadcastLayoutChanged`
// in src/main/services/realtime.ts.
function AreaLayoutEditorModal({
  area,
  defaultCount,
  onClose,
}: {
  area: string;
  defaultCount: number;
  onClose: () => void;
}) {
  // FloorCanvas needs *some* userId for legacy IPC compatibility but the
  // server now ignores it (the layout is shared). Use the admin's id if
  // available, otherwise the current POS user's, otherwise 0.
  const adminUser = useAdminSessionStore((s) => s.user);
  const posUser = useSessionStore((s) => s.user);
  const userId = Number(adminUser?.id || posUser?.id || 0);
  const [editable, setEditable] = useState(true);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex"
      onClick={onClose}
    >
      {/* Full-page editor so the design surface fills the screen and
          matches the dimensions/aspect of the waiter floor view. */}
      <div
        className="bg-gray-800 w-full h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-3 shrink-0">
          <div className="text-base font-semibold flex-1 truncate">
            Layout · {area}
          </div>
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
            onClick={onClose}
          >
            Done
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col p-3 sm:p-4">
          <FloorCanvas
            userId={userId}
            area={area}
            editable={editable}
            onEditableChange={setEditable}
            defaultCount={defaultCount}
            fillAvailableHeight
          />
        </div>
        <div className="px-4 py-2 border-t border-gray-700 text-xs opacity-70 shrink-0">
          Changes save to the shared layout when you press
          <span className="mx-1 text-blue-300">Save layout</span>and appear
          immediately on every waiter and host device.
        </div>
      </div>
    </div>
  );
}

function CloudSettings() {
  const [loading, setLoading] = useState(true);
  const [businessCode, setBusinessCode] = useState('');
  const [accessPassword, setAccessPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [backendUrl, setBackendUrl] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await window.api.settings.get();
        setBackendUrl(String((s as any)?.cloud?.backendUrl || ''));
        setBusinessCode(String((s as any)?.cloud?.businessCode || ''));
        setDisabled(Boolean((s as any)?.cloud?.disabled));
        // Never read back the stored password; user must re-enter if they want to change it.
        setAccessPassword('');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="opacity-70">Loading…</div>;

  const toggleCloud = async (next: boolean) => {
    setStatus(null);
    setToggling(true);
    try {
      // Send only the flag so the businessCode/password validation in
      // settings:update never runs while flipping the kill switch.
      await window.api.settings.update({ cloud: { disabled: next } } as any);
      setDisabled(next);
      const s = await window.api.settings.get();
      setBackendUrl(String((s as any)?.cloud?.backendUrl || ''));
      setStatus(next ? 'Cloud disabled (local-only).' : 'Cloud enabled.');
    } catch (e: any) {
      setStatus(e?.message || 'Failed to update cloud state.');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Log In to Cloud</div>

      <div className="mb-4 rounded border border-gray-700 bg-gray-800/50 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">
              {disabled ? 'Cloud is disabled' : 'Cloud is enabled'}
            </div>
            <div className="text-xs opacity-70">
              {disabled
                ? 'The POS runs local-only. No cloud sync or login, and the “business code missing” banner is hidden.'
                : 'The POS uses the hosted backend when a business code is set.'}
            </div>
          </div>
          <button
            className={`shrink-0 px-3 py-2 rounded ${
              disabled
                ? 'bg-emerald-700 hover:bg-emerald-600'
                : 'bg-red-700 hover:bg-red-600'
            } disabled:opacity-60`}
            type="button"
            disabled={toggling}
            onClick={() => toggleCloud(!disabled)}
          >
            {toggling ? 'Saving…' : disabled ? 'Enable cloud' : 'Disable cloud'}
          </button>
        </div>
      </div>

      <div
        className={`space-y-2 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        <div className="text-xs opacity-70">
          Backend URL (managed by provider)
        </div>
        {/* <input className="bg-gray-700 rounded px-3 py-2 w-full opacity-70" value={backendUrl || '(not configured)'} readOnly /> */}
        <input
          className="bg-gray-700 rounded px-3 py-2 w-full"
          placeholder="Business code (e.g.  Code Orbit)"
          value={businessCode}
          onChange={(e) => setBusinessCode(e.target.value.toUpperCase())}
        />
        <div className="text-xs opacity-70 mt-2">
          Business password (provided by provider)
        </div>
        <div className="text-xs opacity-60">
          You will not see the saved password again. If you need to change it,
          re-enter a new one.
        </div>
        <div className="flex items-center gap-2">
          <input
            className="bg-gray-700 rounded px-3 py-2 w-full"
            placeholder="Cloud access password"
            value={accessPassword}
            onChange={(e) => setAccessPassword(e.target.value)}
            type={showPassword ? 'text' : 'password'}
            autoComplete="off"
          />
          <button
            className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            title={showPassword ? 'Hide' : 'Show'}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
        <button
          className="px-3 py-2 rounded bg-emerald-700 w-full"
          onClick={async () => {
            setStatus(null);
            try {
              const updated = await window.api.settings.update({
                cloud: { businessCode, accessPassword },
              } as any);
              setBackendUrl(
                String((updated as any)?.cloud?.backendUrl || backendUrl),
              );
              setBusinessCode(
                String((updated as any)?.cloud?.businessCode || businessCode),
              );
              setAccessPassword('');
              setStatus('Saved.');
            } catch (e: any) {
              setStatus(e?.message || 'Save failed.');
            }
          }}
        >
          Save Cloud Settings
        </button>
        <div className="text-xs opacity-70">
          When set, the app will use the hosted backend for
          staff/menu/shifts/tickets (printing remains local).
        </div>
        {status && <div className="text-xs opacity-80">{status}</div>}
      </div>
    </div>
  );
}

function AboutSettings() {
  const [loading, setLoading] = useState(true);
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        if (cancelled) return;
        setBusinessName(String(s?.restaurantName || '').trim());
        setAddress(String(s?.businessInfo?.address || ''));
        setPhone(String(s?.businessInfo?.phone || ''));
        setEmail(String(s?.businessInfo?.email || ''));
        setWebsite(String(s?.businessInfo?.website || ''));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setStatus(null);
    setSaving(true);
    try {
      const nm = String(businessName || '').trim();
      if (nm.length < 2) {
        setStatus('Business name is required.');
        return;
      }
      const em = String(email || '').trim();
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        setStatus('Business email is invalid.');
        return;
      }
      await window.api.settings.update({
        // Keep backward compatibility: this is the name used across the app today.
        restaurantName: nm,
        businessInfo: {
          address: String(address || ''),
          phone: String(phone || ''),
          email: em,
          website: String(website || ''),
        },
      } as any);
      setStatus('Saved.');
    } catch (e: any) {
      setStatus(String(e?.message || 'Save failed.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Business Info</div>
      {loading ? (
        <div className="flex items-center justify-center min-h-[260px]">
          <div className="rounded border border-gray-700 bg-gray-900/40 px-4 py-3 flex items-center gap-3">
            <div className="w-4 h-4 rounded-full border-2 border-gray-500 border-t-transparent animate-spin" />
            <div className="text-sm opacity-80">Loading…</div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="text-xs opacity-70 mb-1">Business name</div>
            <input
              className="bg-gray-700 rounded px-3 py-2 w-full"
              placeholder="e.g. My Restaurant"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
            />
          </div>

          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="text-xs opacity-70 mb-1">Business address</div>
            <textarea
              className="bg-gray-700 rounded px-3 py-2 w-full min-h-[80px]"
              placeholder="Street, city, postal code"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>

          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="text-xs opacity-70 mb-1">Phone number</div>
            <input
              className="bg-gray-700 rounded px-3 py-2 w-full"
              placeholder="+355 …"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>

          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="text-xs opacity-70 mb-1">Business email</div>
            <input
              className="bg-gray-700 rounded px-3 py-2 w-full"
              placeholder="info@restaurant.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              inputMode="email"
            />
          </div>

          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="text-xs opacity-70 mb-1">Business website</div>
            <input
              className="bg-gray-700 rounded px-3 py-2 w-full"
              placeholder="https://restaurant.com"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              inputMode="url"
            />
          </div>

          <button
            className="px-3 py-2 rounded bg-emerald-700 w-full disabled:opacity-60"
            onClick={() => void save()}
            disabled={saving}
            type="button"
          >
            {saving ? 'Saving…' : 'Save Business Info'}
          </button>

          {status && <div className="text-xs opacity-80">{status}</div>}
          <div className="text-xs opacity-60">
            These details will be used on printed receipts next.
          </div>
        </div>
      )}
    </div>
  );
}

function LanSettings() {
  const [loading, setLoading] = useState(true);
  const [allowLan, setAllowLan] = useState(false);
  const [requirePairingCode, setRequirePairingCode] = useState(true);
  const [pairingCode, setPairingCode] = useState<string>('');
  const [ips, setIps] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, ipList] = await Promise.all([
          window.api.settings.get(),
          window.api.network.getIps().catch(() => [] as string[]),
        ]);
        setAllowLan(Boolean((s as any)?.security?.allowLan));
        setRequirePairingCode(
          Boolean((s as any)?.security?.requirePairingCode ?? true),
        );
        setPairingCode(String((s as any)?.security?.pairingCode || ''));
        setIps(ipList || []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function pickBestLanIp(list: string[]): string {
    const rank = (ip: string) => {
      if (ip.startsWith('192.168.')) return 0; // most common Wi‑Fi LAN
      if (ip.startsWith('10.')) return 1;
      if (
        ip.startsWith('172.16.') ||
        ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') ||
        ip.startsWith('172.19.')
      )
        return 3;
      if (ip.startsWith('172.2') || ip.startsWith('172.3')) return 3; // 172.20-31 (rough)
      if (ip.startsWith('172.')) return 4;
      return 9;
    };
    return (
      (list || [])
        .filter(Boolean)
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] || ''
    );
  }

  const primaryIp = pickBestLanIp(ips);
  const LAN_HTTP = '3333';
  const LAN_HTTPS = '3443';
  // Hash routing: put setup params in ? before # so the shell reads them on first paint.
  const staffSetupUrl = primaryIp
    ? (() => {
        const q = new URLSearchParams({
          backend: primaryIp,
          http: LAN_HTTP,
          https: LAN_HTTPS,
        });
        if (requirePairingCode && pairingCode && /^\d{6}$/.test(pairingCode)) {
          q.set('pairing', pairingCode);
        }
        return `http://${primaryIp}:${LAN_HTTP}/renderer/?${q.toString()}#/`;
      })()
    : '';
  const lanUrl = primaryIp ? `http://${primaryIp}:${LAN_HTTP}/renderer/#/` : '';

  async function saveSecurity(next: {
    allowLan?: boolean;
    requirePairingCode?: boolean;
    pairingCode?: string;
  }) {
    setStatus(null);
    const updated = await window.api.settings.update({ security: next } as any);
    setAllowLan(Boolean((updated as any)?.security?.allowLan));
    setRequirePairingCode(
      Boolean((updated as any)?.security?.requirePairingCode ?? true),
    );
    setPairingCode(
      String((updated as any)?.security?.pairingCode || next.pairingCode || ''),
    );
    setStatus('Saved.');
  }

  return (
    <div>
      <div className="text-lg font-semibold mb-3">LAN / Tablets</div>

      {loading ? (
        <div className="opacity-70">Loading…</div>
      ) : (
        <>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 opacity-80">
              <div>
                <div className="font-medium">App access</div>
                <div className="text-xs opacity-70">
                  The desktop app can always reach the POS locally. This cannot
                  be disabled.
                </div>
              </div>
              <input type="checkbox" checked readOnly disabled />
            </div>

            <label className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">Allow browser access</div>
                <div className="text-xs opacity-70">
                  Lets waiters open the POS from a browser on the same network
                  (tablet/phone web browsers, laptops). The installed POS app on
                  iOS/Android always works regardless of this toggle. Takes
                  effect immediately after saving — already-connected browsers
                  will lose access on their next request.
                </div>
              </div>
              <input
                type="checkbox"
                checked={allowLan}
                onChange={(e) => setAllowLan(e.target.checked)}
              />
            </label>

            <label className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">Require pairing code</div>
                <div className="text-xs opacity-70">
                  Tablet / phone logins (browser and native app) must enter the
                  pairing code shown below.
                </div>
              </div>
              <input
                type="checkbox"
                checked={requirePairingCode}
                onChange={(e) => setRequirePairingCode(e.target.checked)}
              />
            </label>

            <button
              className="px-3 py-2 rounded bg-emerald-700 w-full"
              onClick={async () => {
                await saveSecurity({ allowLan, requirePairingCode });
              }}
            >
              Save LAN Settings
            </button>

            {!allowLan && (
              <div className="mt-3 p-3 rounded bg-gray-900/40 border border-gray-700 text-xs opacity-80">
                Browser access is disabled. The desktop app and the installed
                iOS / Android POS app can still connect. Enable “Allow browser
                access” above to let waiters open the POS from a regular web
                browser too.
              </div>
            )}

            <div className="mt-4 p-3 rounded bg-gray-900/50 border border-gray-700">
              <div className="text-sm font-semibold mb-2">Pairing code</div>
              <div className="flex items-center gap-2">
                <input
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  value={pairingCode || '(not generated yet)'}
                  readOnly
                />
                <button
                  className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
                  onClick={async () => {
                    const code = String(
                      Math.floor(100000 + Math.random() * 900000),
                    );
                    await saveSecurity({ pairingCode: code });
                  }}
                >
                  Regenerate
                </button>
              </div>
              <div className="text-xs opacity-70 mt-2">
                Use this code on tablets when logging in.
              </div>
            </div>

            <div className="mt-3 p-3 rounded bg-gray-900/50 border border-gray-700">
              <div className="text-sm font-semibold mb-2">
                Tablet setup link
              </div>
              {staffSetupUrl ? (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      className="bg-gray-700 rounded px-3 py-2 flex-1 text-xs"
                      value={staffSetupUrl}
                      readOnly
                    />
                    <button
                      className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 shrink-0"
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(staffSetupUrl);
                          setStatus('Copied tablet setup link.');
                        } catch {
                          setStatus('Copy failed.');
                        }
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <div className="text-xs opacity-70 mt-2">
                    <span className="font-medium text-emerald-200/90">
                      Use this on each tablet once.
                    </span>{' '}
                    It saves this venue&apos;s IP, ports, and pairing code in
                    the browser so staff don&apos;t re-enter them after
                    restarting the POS or reopening the app (same device &amp;
                    browser).
                  </div>
                </>
              ) : (
                <div className="text-xs opacity-70">
                  No Wi‑Fi IP detected. Connect this Mac to Wi‑Fi or Ethernet
                  and reopen this page.
                </div>
              )}
            </div>

            <div
              className={`mt-3 p-3 rounded bg-gray-900/50 border border-gray-700 ${
                allowLan ? '' : 'opacity-50 pointer-events-none'
              }`}
            >
              <div className="text-sm font-semibold mb-2">
                Plain URL{' '}
                <span className="text-xs opacity-60">(browser, optional)</span>
              </div>
              {lanUrl ? (
                <div className="flex items-center gap-2">
                  <input
                    className="bg-gray-700 rounded px-3 py-2 flex-1"
                    value={lanUrl}
                    readOnly
                  />
                  <button
                    className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(lanUrl);
                        setStatus('Copied plain URL.');
                      } catch {
                        setStatus('Copy failed.');
                      }
                    }}
                  >
                    Copy
                  </button>
                </div>
              ) : (
                <div className="text-xs opacity-70">
                  No Wi‑Fi IP detected. Connect to Wi‑Fi or Ethernet and reopen
                  this page.
                </div>
              )}
              <div className="text-xs opacity-70 mt-2">
                Same app without setup parameters — tablets may need to use{' '}
                <span className="font-medium">Configure server</span> and the
                pairing code manually unless they opened the tablet setup link
                above first.
              </div>
            </div>

            {status && <div className="text-xs opacity-80 mt-2">{status}</div>}
          </div>
        </>
      )}
    </div>
  );
}

function MemoryMonitorSection() {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let interval: number | null = null;
    const loadStats = async () => {
      try {
        const data = await window.api.admin.getMemoryStats();
        if (!cancelled) setStats(data);
      } catch (e) {
        if (!cancelled) console.error('Failed to load memory stats', e);
      }
    };

    const start = () => {
      if (interval != null) return;
      loadStats();
      interval = window.setInterval(loadStats, 5000);
    };
    const stop = () => {
      if (interval != null) {
        window.clearInterval(interval);
        interval = null;
      }
    };

    // PERF: pause polling when the admin tab is hidden so we don't spend
    // CPU / IPC bandwidth refreshing memory stats nobody is looking at.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState !== 'hidden') start();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      const path = await window.api.admin.exportMemorySnapshot();
      toast.success(`Memory snapshot exported to: ${path}`, {
        title: 'Exported',
      });
    } catch (e: any) {
      toast.error(`Failed to export: ${e?.message || 'Unknown error'}`, {
        title: 'Export failed',
      });
    } finally {
      setExporting(false);
    }
  };

  if (!stats) {
    return (
      <div>
        <div className="text-lg font-semibold mb-3">Memory Monitoring</div>
        <div className="text-gray-400">Loading memory stats...</div>
      </div>
    );
  }

  const trendColor =
    stats.trend === 'increasing'
      ? 'text-yellow-400'
      : stats.trend === 'decreasing'
        ? 'text-green-400'
        : 'text-gray-400';

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Memory Monitoring</div>
      <div className="space-y-4">
        <div className="bg-gray-900/50 rounded-lg p-4 border border-gray-700">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-sm text-gray-400 mb-1">
                Current Heap Used
              </div>
              <div className="text-lg font-semibold">
                {stats.formatted.heapUsed}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-400 mb-1">
                RSS (Total Memory)
              </div>
              <div className="text-lg font-semibold">{stats.formatted.rss}</div>
            </div>
            <div>
              <div className="text-sm text-gray-400 mb-1">Peak Heap Used</div>
              <div className="text-lg font-semibold">
                {(stats.peak.heapUsed / 1024 / 1024).toFixed(2)} MB
              </div>
              <div className="text-xs text-gray-500">
                {new Date(stats.peak.timestamp).toLocaleTimeString()}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-400 mb-1">Trend</div>
              <div className={`text-lg font-semibold ${trendColor}`}>
                {stats.trend === 'increasing'
                  ? '⚠️ Increasing'
                  : stats.trend === 'decreasing'
                    ? '✓ Decreasing'
                    : '→ Stable'}
              </div>
            </div>
          </div>
        </div>
        <div className="pt-2">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
          >
            {exporting ? 'Exporting...' : 'Export Memory Snapshot'}
          </button>
          <div className="text-xs text-gray-500 mt-2">
            Memory is monitored automatically. Export snapshot for detailed
            analysis.
          </div>
        </div>
      </div>
    </div>
  );
}
