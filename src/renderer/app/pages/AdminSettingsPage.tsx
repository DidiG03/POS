import { useEffect, useState } from 'react';
import type { UpdateStatusDTO } from '@shared/ipc';

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
  | { key: 'kds'; label: string }
  | { key: 'preferences'; label: string }
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
  { key: 'kds', label: 'Kitchen Display' },
  { key: 'preferences', label: 'Preferences' },
  { key: 'backups', label: 'Backups' },
  { key: 'memory', label: 'Memory Monitoring' },
  { key: 'cloud', label: 'Log In to Cloud' },
  { key: 'updates', label: 'System Updates' },
  { key: 'billing', label: 'Billing' },
  { key: 'lan', label: 'LAN / Tablets' },
  { key: 'about', label: 'About' },
];

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
              >
                <div className="flex items-center justify-between">
                  <span>{s.label}</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="w-4 h-4 opacity-70"
                    aria-hidden
                  >
                    <path
                      fillRule="evenodd"
                      d="M9.22 4.22a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L14.94 12 9.22 5.28a.75.75 0 010-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="bg-gray-800 rounded p-4 overflow-auto">
        {selected === 'printer' && <PrinterSettings />}
        {selected === 'areas' && <AreasSettings />}
        {selected === 'kds' && <KdsSettings />}
        {selected === 'preferences' && <PreferencesSettings />}
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
            Check for new POS versions and install updates.
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
  const [vatEnabled, setVatEnabled] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [value, setValue] = useState<string>('10');
  const [requireMgrDiscount, setRequireMgrDiscount] = useState(true);
  const [requireMgrVoid, setRequireMgrVoid] = useState(true);
  const [requireMgrServiceRemoval, setRequireMgrServiceRemoval] =
    useState(true);
  const [status, setStatus] = useState<string | null>(null);

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
        setVatEnabled((s as any)?.preferences?.vatEnabled !== false);
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
      setStatus('Currency must be a 3-letter ISO code (e.g. EUR, QAR, USD).');
      return;
    }
    const n = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      setStatus('Invalid amount.');
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
        vatEnabled,
        serviceCharge: { enabled, mode, value: n },
      },
    } as any);
    setStatus('Saved.');
  }

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Preferences</div>
      {loading ? (
        <div className="opacity-70">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">Currency</div>
            <div className="text-xs opacity-70 mb-3">
              Currency used across the POS (tickets, reports, receipts). Use a
              3-letter ISO code like EUR, QAR, USD.
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input
                className="col-span-2 bg-gray-700 rounded px-3 py-2 uppercase"
                value={currency}
                onChange={(e) =>
                  setCurrency(
                    e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z]/g, '')
                      .slice(0, 3),
                  )
                }
                placeholder="EUR"
              />
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
            <div className="font-medium mb-1">VAT</div>
            <div className="text-xs opacity-70 mb-3">
              Enable/disable VAT calculations on tickets and receipts.
            </div>
            <label className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">Enable VAT</div>
              </div>
              <input
                type="checkbox"
                checked={vatEnabled}
                onChange={(e) => setVatEnabled(e.target.checked)}
              />
            </label>
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

function BackupsSettings() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<
    Array<{ name: string; bytes: number; createdAt: string }>
  >([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
        current database and restart the app.
      </div>

      <div className="flex gap-2 mb-3">
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
          ))}
        </div>
      )}
    </div>
  );
}

function KdsSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState<{
    KITCHEN: boolean;
    BAR: boolean;
    DESSERT: boolean;
  }>({
    KITCHEN: true,
    BAR: false,
    DESSERT: false,
  });
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s: any = await window.api.settings.get();
        const raw = (s as any)?.kds?.enabledStations;
        const arr = (Array.isArray(raw) ? raw : ['KITCHEN']).map((x: any) =>
          String(x).toUpperCase(),
        );
        const next = { KITCHEN: false, BAR: false, DESSERT: false };
        for (const x of arr) {
          if (x === 'KITCHEN' || x === 'BAR' || x === 'DESSERT')
            (next as any)[x] = true;
        }
        // Safety: must have at least kitchen
        if (!next.KITCHEN && !next.BAR && !next.DESSERT) next.KITCHEN = true;
        setEnabled(next);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const enabledStations = [
    enabled.KITCHEN ? 'KITCHEN' : null,
    enabled.BAR ? 'BAR' : null,
    enabled.DESSERT ? 'DESSERT' : null,
  ].filter(Boolean) as Array<'KITCHEN' | 'BAR' | 'DESSERT'>;

  if (loading) return <div className="opacity-70">Loading…</div>;

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Kitchen Display (KDS)</div>
      <div className="space-y-3">
        <div className="text-xs opacity-70">
          Choose which stations exist in your kitchen screens.
        </div>
        <label className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium">Kitchen</div>
            <div className="text-xs opacity-70">
              Default station (recommended)
            </div>
          </div>
          <input
            type="checkbox"
            checked={enabled.KITCHEN}
            onChange={(e) => {
              // Always keep at least one station enabled
              const next = { ...enabled, KITCHEN: e.target.checked };
              if (!next.KITCHEN && !next.BAR && !next.DESSERT)
                next.KITCHEN = true;
              setEnabled(next);
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <div className="font-medium">Bar</div>
          <input
            type="checkbox"
            checked={enabled.BAR}
            onChange={(e) =>
              setEnabled((s) => ({ ...s, BAR: e.target.checked }))
            }
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <div className="font-medium">Dessert</div>
          <input
            type="checkbox"
            checked={enabled.DESSERT}
            onChange={(e) =>
              setEnabled((s) => ({ ...s, DESSERT: e.target.checked }))
            }
          />
        </label>

        <button
          className="px-3 py-2 rounded bg-emerald-700 w-full"
          onClick={async () => {
            setStatus(null);
            try {
              await window.api.settings.update({
                kds: { enabledStations },
              } as any);
              setStatus('Saved.');
            } catch (e: any) {
              setStatus(e?.message || 'Save failed.');
            }
          }}
        >
          Save KDS Settings
        </button>

        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 w-full"
          onClick={async () => {
            setStatus(null);
            await window.api.kds.openWindow();
          }}
        >
          Open Kitchen Display
        </button>

        {status && <div className="text-xs opacity-80">{status}</div>}
      </div>
    </div>
  );
}

function PrinterSettings() {
  const CATEGORY_PRESETS = [
    'Drinks',
    'Food',
    'Desserts',
    'Starters',
    'Mains',
    'Sides',
    'Salads',
    'Breakfast',
    'Hot Drinks',
    'Soft Drinks',
    'Alcohol',
  ] as const;

  type Profile = {
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
  };

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [receiptPrinterId, setReceiptPrinterId] = useState<string>('default');
  const [stationKitchen, setStationKitchen] = useState<string>('');
  const [stationBar, setStationBar] = useState<string>('');
  const [stationDessert, setStationDessert] = useState<string>('');
  const [stationAll, setStationAll] = useState<string>('default');
  const [categoryRouting, setCategoryRouting] = useState<
    Record<string, string>
  >({});

  const [printers, setPrinters] = useState<
    { name: string; isDefault?: boolean }[]
  >([]);
  const [serialPorts, setSerialPorts] = useState<
    { path: string; manufacturer?: string }[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const ensureProfile = (p: any, idx: number): Profile => {
    const id = String(
      p?.id || `p${idx}-${Math.random().toString(16).slice(2, 8)}`,
    );
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
      setStationKitchen(String(r?.station?.KITCHEN || ''));
      setStationBar(String(r?.station?.BAR || ''));
      setStationDessert(String(r?.station?.DESSERT || ''));
      setStationAll(String(r?.station?.ALL || 'default'));
      // Category routing keys are stored as normalized category names (lowercase), but we also accept legacy numeric keys.
      const cats = (await window.api.menu
        .listCategoriesWithItems()
        .catch(() => [] as any[])) as any[];
      const idToName = new Map<string, string>();
      for (const c of cats) idToName.set(String(c.id), String(c.name || ''));
      const rawCatMap: Record<string, string> = (r?.categories || {}) as any;
      const norm = (x: any) =>
        String(x ?? '')
          .trim()
          .toLowerCase();
      const next: Record<string, string> = {};
      for (const preset of CATEGORY_PRESETS) {
        const key = norm(preset);
        next[key] = rawCatMap[key] || '';
      }
      // migrate numeric keys if possible
      for (const [k, v] of Object.entries(rawCatMap || {})) {
        if (/^\d+$/.test(String(k))) {
          const nm = idToName.get(String(k));
          const nk = nm ? norm(nm) : '';
          if (nk && next[nk] == null) next[nk] = String(v || '');
        }
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

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Printers</div>
      {status && <div className="text-xs text-amber-200 mb-3">{status}</div>}

      <div className="bg-gray-800/40 border border-gray-700 rounded p-3 mb-4">
        <div className="font-semibold mb-2">Routing (multiple printers)</div>
        <label className="flex items-center justify-between gap-3 mb-2">
          <div className="text-sm">Enable routing (Kitchen/Bar/Dessert)</div>
          <input
            type="checkbox"
            checked={routingEnabled}
            onChange={(e) => setRoutingEnabled(e.target.checked)}
          />
        </label>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <label className="text-sm">
            <div className="opacity-80 mb-1">Receipt printer (PAYMENT)</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={receiptPrinterId}
              onChange={(e) => setReceiptPrinterId(e.target.value)}
            >
              {pickOptions(false)}
            </select>
          </label>
          <label className="text-sm">
            <div className="opacity-80 mb-1">Fallback printer (ALL)</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={stationAll}
              onChange={(e) => setStationAll(e.target.value)}
            >
              {pickOptions(false)}
            </select>
          </label>
          <label className="text-sm">
            <div className="opacity-80 mb-1">Kitchen printer (ORDER)</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={stationKitchen}
              onChange={(e) => setStationKitchen(e.target.value)}
            >
              {pickOptions()}
            </select>
          </label>
          <label className="text-sm">
            <div className="opacity-80 mb-1">Bar printer (ORDER)</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={stationBar}
              onChange={(e) => setStationBar(e.target.value)}
            >
              {pickOptions()}
            </select>
          </label>
          <label className="text-sm">
            <div className="opacity-80 mb-1">Dessert printer (ORDER)</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={stationDessert}
              onChange={(e) => setStationDessert(e.target.value)}
            >
              {pickOptions()}
            </select>
          </label>
        </div>

        <div className="text-xs opacity-70 mt-2">
          Tip: “Bluetooth” printers often appear as <b>Serial</b> (COM /
          /dev/tty.*) or an OS <b>System printer</b>. Routing uses each menu
          item’s <b>Station</b> (Kitchen/Bar/Dessert).
        </div>
      </div>

      <div className="bg-gray-800/40 border border-gray-700 rounded p-3 mb-4">
        <div className="font-semibold mb-2">
          Category → printer (recommended)
        </div>
        <div className="text-xs opacity-70 mb-2">
          Categories are selected from a preset list (Drinks/Food/Desserts/etc).
          Here you choose which printer each category should go to. This
          overrides station routing when set.
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {CATEGORY_PRESETS.map((c) => {
            const key = String(c).toLowerCase();
            return (
              <label key={c} className="text-sm">
                <div className="opacity-80 mb-1">{c}</div>
                <select
                  className="w-full bg-gray-700 rounded px-3 py-2"
                  value={categoryRouting[key] || ''}
                  onChange={(e) =>
                    setCategoryRouting((m) => ({ ...m, [key]: e.target.value }))
                  }
                >
                  <option value="">(use station routing)</option>
                  {enabledProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.mode})
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </div>

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

      <div className="space-y-3">
        {profiles.map((p) => (
          <div
            key={p.id}
            className="border border-gray-700 rounded p-3 bg-gray-900/30"
          >
            <div className="flex items-center gap-2 mb-2">
              <input
                className="bg-gray-700 rounded px-3 py-2 flex-1"
                placeholder="Printer name"
                value={p.name}
                onChange={(e) =>
                  setProfiles((arr) =>
                    arr.map((x) =>
                      x.id === p.id ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
              />
              <label className="text-sm flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={p.enabled !== false}
                  onChange={(e) =>
                    setProfiles((arr) =>
                      arr.map((x) =>
                        x.id === p.id ? { ...x, enabled: e.target.checked } : x,
                      ),
                    )
                  }
                />
                Enabled
              </label>
              <button
                className="px-2 py-2 rounded bg-red-700 hover:bg-red-800"
                onClick={() =>
                  setProfiles((arr) => arr.filter((x) => x.id !== p.id))
                }
              >
                x
              </button>
            </div>

            <div className="flex items-center gap-2 mb-2">
              <div className="text-xs opacity-70">ID: {p.id}</div>
              <div className="flex-1" />
              <select
                className="bg-gray-700 rounded px-3 py-2"
                value={p.mode || 'NETWORK'}
                onChange={(e) =>
                  setProfiles((arr) =>
                    arr.map((x) =>
                      x.id === p.id ? { ...x, mode: e.target.value as any } : x,
                    ),
                  )
                }
              >
                <option value="NETWORK">Network (ESC/POS)</option>
                <option value="SYSTEM">USB / System printer</option>
                <option value="SERIAL">
                  Serial (ESC/POS / many Bluetooth)
                </option>
              </select>
            </div>

            {p.mode === 'NETWORK' ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    className="bg-gray-700 rounded px-3 py-2 flex-1"
                    placeholder="Printer IP (e.g. 192.168.1.50)"
                    value={p.ip || ''}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id ? { ...x, ip: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <input
                    className="w-28 bg-gray-700 rounded px-3 py-2"
                    type="number"
                    min={1}
                    value={Number(p.port || 9100)}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, port: Number(e.target.value) }
                            : x,
                        ),
                      )
                    }
                  />
                </div>
                <div className="text-xs opacity-70">
                  Raw TCP 9100 (default) or LPR 515.
                </div>
              </div>
            ) : p.mode === 'SYSTEM' ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <select
                    className="bg-gray-700 rounded px-3 py-2 flex-1"
                    value={p.deviceName || ''}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, deviceName: e.target.value }
                            : x,
                        ),
                      )
                    }
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
                    onClick={async () => {
                      const list =
                        (await (window.api.settings as any).listPrinters?.()) ||
                        [];
                      setPrinters(list);
                    }}
                  >
                    Refresh
                  </button>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={p.silent !== false}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, silent: e.target.checked }
                            : x,
                        ),
                      )
                    }
                  />
                  Silent print (no OS dialog)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={p.systemRawEscpos !== false}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, systemRawEscpos: e.target.checked }
                            : x,
                        ),
                      )
                    }
                  />
                  Send raw ESC/POS (recommended for receipt printers; fixes
                  “printing code”)
                </label>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <select
                    className="bg-gray-700 rounded px-3 py-2 flex-1"
                    value={p.serialPath || ''}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, serialPath: e.target.value }
                            : x,
                        ),
                      )
                    }
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
                    onClick={async () => {
                      try {
                        const list =
                          (await (
                            window.api.settings as any
                          ).listSerialPorts?.()) || [];
                        setSerialPorts(list);
                        if (!list.length)
                          setStatus(
                            'No serial ports found. If you see an error in console, run: pnpm run serial:rebuild',
                          );
                      } catch (e: any) {
                        setStatus(
                          String(
                            e?.message ||
                              'Serial ports unavailable. Run: pnpm run serial:rebuild',
                          ),
                        );
                      }
                    }}
                  >
                    Refresh
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    className="w-32 bg-gray-700 rounded px-3 py-2"
                    type="number"
                    min={1200}
                    value={Number(p.baudRate || 19200)}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, baudRate: Number(e.target.value) }
                            : x,
                        ),
                      )
                    }
                  />
                  <select
                    className="bg-gray-700 rounded px-3 py-2"
                    value={p.parity || 'none'}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, parity: e.target.value as any }
                            : x,
                        ),
                      )
                    }
                  >
                    <option value="none">Parity: none</option>
                    <option value="even">Parity: even</option>
                    <option value="odd">Parity: odd</option>
                  </select>
                  <select
                    className="bg-gray-700 rounded px-3 py-2"
                    value={p.dataBits || 8}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, dataBits: Number(e.target.value) as any }
                            : x,
                        ),
                      )
                    }
                  >
                    <option value={8}>Data: 8</option>
                    <option value={7}>Data: 7</option>
                  </select>
                  <select
                    className="bg-gray-700 rounded px-3 py-2"
                    value={p.stopBits || 1}
                    onChange={(e) =>
                      setProfiles((arr) =>
                        arr.map((x) =>
                          x.id === p.id
                            ? { ...x, stopBits: Number(e.target.value) as any }
                            : x,
                        ),
                      )
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
          </div>
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
                station: {
                  KITCHEN: stationKitchen || undefined,
                  BAR: stationBar || undefined,
                  DESSERT: stationDessert || undefined,
                  ALL: stationAll || undefined,
                },
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

function AreasSettings() {
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
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

      <div className="space-y-2">
        {areas.map((a, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <input
              className="bg-gray-700 rounded px-2 py-1 flex-1"
              value={a.name}
              onChange={(e) =>
                setAreas((arr) =>
                  arr.map((x, i) =>
                    i === idx ? { ...x, name: e.target.value } : x,
                  ),
                )
              }
            />
            <input
              className="w-24 bg-gray-700 rounded px-2 py-1"
              type="number"
              min={0}
              value={a.count}
              onChange={(e) =>
                setAreas((arr) =>
                  arr.map((x, i) =>
                    i === idx ? { ...x, count: Number(e.target.value) } : x,
                  ),
                )
              }
            />
            <button
              className="p-1 rounded bg-red-600 hover:bg-red-700 cursor-pointer"
              onClick={() => setAreas((arr) => arr.filter((_, i) => i !== idx))}
            >
              x
            </button>
          </div>
        ))}
        <div>
          <button
            className="mt-2 px-3 py-2 rounded bg-emerald-700 w-full"
            onClick={async () => {
              await window.api.settings.update({ tableAreas: areas });
            }}
          >
            Save Areas
          </button>
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

  useEffect(() => {
    (async () => {
      try {
        const s = await window.api.settings.get();
        setBackendUrl(String((s as any)?.cloud?.backendUrl || ''));
        setBusinessCode(String((s as any)?.cloud?.businessCode || ''));
        // Never read back the stored password; user must re-enter if they want to change it.
        setAccessPassword('');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="opacity-70">Loading…</div>;

  return (
    <div>
      <div className="text-lg font-semibold mb-3">Log In to Cloud</div>
      <div className="space-y-2">
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
  // Use hash routing explicitly; this is the URL we previously tested with tablets/phones.
  const lanUrl = primaryIp ? `http://${primaryIp}:3333/renderer/#/` : '';

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
            <label className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">Allow tablets on LAN</div>
                <div className="text-xs opacity-70">
                  Enables network access to the local API. Requires app restart
                  to take effect.
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
                  Tablet logins must enter the pairing code shown here.
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
              <div className="text-sm font-semibold mb-2">Tablet URL</div>
              {lanUrl ? (
                <div className="flex items-center gap-2">
                  <input
                    className="bg-gray-700 rounded px-3 py-2 flex-1"
                    value={lanUrl}
                    readOnly
                  />
                  <button
                    className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(lanUrl);
                        setStatus('Copied URL.');
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
                Open this on the tablet’s browser (same Wi‑Fi).
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
    const loadStats = async () => {
      try {
        const data = await window.api.admin.getMemoryStats();
        if (!cancelled) setStats(data);
      } catch (e) {
        if (!cancelled) console.error('Failed to load memory stats', e);
      }
    };

    loadStats();
    const interval = setInterval(loadStats, 5000); // Refresh every 5 seconds
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      const path = await window.api.admin.exportMemorySnapshot();
      alert(`Memory snapshot exported to: ${path}`);
    } catch (e: any) {
      alert(`Failed to export: ${e?.message || 'Unknown error'}`);
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
