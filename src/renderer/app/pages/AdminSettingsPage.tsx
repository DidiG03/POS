import { useEffect, useState } from 'react';

type Section =
  | { key: 'printer'; label: string }
  | { key: 'areas'; label: string }
  | { key: 'kds'; label: string }
  | { key: 'preferences'; label: string }
  | { key: 'backups'; label: string }
  | { key: 'cloud'; label: string }
  | { key: 'lan'; label: string }
  | { key: 'about'; label: string };

const sections: Section[] = [
  { key: 'printer', label: 'Printer' },
  { key: 'areas', label: 'Table Areas' },
  { key: 'kds', label: 'Kitchen Display' },
  { key: 'preferences', label: 'Preferences' },
  { key: 'backups', label: 'Backups' },
  { key: 'cloud', label: 'Log In to Cloud' },
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
                    <path fillRule="evenodd" d="M9.22 4.22a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L14.94 12 9.22 5.28a.75.75 0 010-1.06z" clipRule="evenodd" />
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
        {selected === 'cloud' && <CloudSettings />}
        {selected === 'lan' && <LanSettings />}
        {selected === 'about' && <AboutSettings />}
      </div>
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
  const [requireMgrServiceRemoval, setRequireMgrServiceRemoval] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        const cur = String((s as any)?.currency || 'EUR').trim().toUpperCase() || 'EUR';
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
        setRequireMgrServiceRemoval(approvals.requireManagerPinForServiceChargeRemoval !== false);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    setStatus(null);
    const cur = String(currency || '').trim().toUpperCase();
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
              Currency used across the POS (tickets, reports, receipts). Use a 3-letter ISO code like EUR, QAR, USD.
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input
                className="col-span-2 bg-gray-700 rounded px-3 py-2 uppercase"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))}
                placeholder="EUR"
              />
              <select
                className="bg-gray-700 rounded px-3 py-2"
                value={currency}
                onChange={(e) => setCurrency(String(e.target.value || '').toUpperCase())}
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
            <div className="text-xs opacity-70 mb-3">Require an ADMIN PIN to approve sensitive actions on waiter terminals.</div>
            <div className="space-y-3">
              <label className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Require manager PIN for discounts</div>
                  <div className="text-xs opacity-70">Any discount at payment requires approval.</div>
                </div>
                <input type="checkbox" checked={requireMgrDiscount} onChange={(e) => setRequireMgrDiscount(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Require manager PIN for voids</div>
                  <div className="text-xs opacity-70">Voiding items/tickets requires approval.</div>
                </div>
                <input type="checkbox" checked={requireMgrVoid} onChange={(e) => setRequireMgrVoid(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Require manager PIN to remove service charge</div>
                  <div className="text-xs opacity-70">Removing service charge on a ticket requires approval.</div>
                </div>
                <input type="checkbox" checked={requireMgrServiceRemoval} onChange={(e) => setRequireMgrServiceRemoval(e.target.checked)} />
              </label>
            </div>
          </div>
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">VAT</div>
            <div className="text-xs opacity-70 mb-3">Enable/disable VAT calculations on tickets and receipts.</div>
            <label className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">Enable VAT</div>
              </div>
              <input type="checkbox" checked={vatEnabled} onChange={(e) => setVatEnabled(e.target.checked)} />
            </label>
          </div>
          <div className="p-3 rounded bg-gray-900/50 border border-gray-700">
            <div className="font-medium mb-1">Service charge</div>
            <div className="text-xs opacity-70 mb-3">Adds an automatic service charge to the bill. Waiters can remove it per ticket.</div>

            <label className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-sm">Enable service charge</div>
              </div>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
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

            <button className="mt-3 w-full px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800" onClick={save}>
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
  const [rows, setRows] = useState<Array<{ name: string; bytes: number; createdAt: string }>>([]);
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
        Backups are stored on this POS computer. Restoring will overwrite the current database and restart the app.
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
            <div key={b.name} className="p-3 flex items-center justify-between gap-3">
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
                  const ok = confirm(`Restore backup ${b.name}?\n\nThis will overwrite the current database and restart the app.`);
                  if (!ok) return;
                  setBusy(`restore:${b.name}`);
                  setStatus(null);
                  try {
                    const r = await (window.api as any).backups.restore({ name: b.name });
                    if (!r?.ok) setStatus(r?.error || 'Restore failed');
                    else if (r?.devRestartRequired) setStatus('Restored. App will close now (dev mode). Please run "npm run dev" again.');
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
  const [enabled, setEnabled] = useState<{ KITCHEN: boolean; BAR: boolean; DESSERT: boolean }>({
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
        const arr = (Array.isArray(raw) ? raw : ['KITCHEN']).map((x: any) => String(x).toUpperCase());
        const next = { KITCHEN: false, BAR: false, DESSERT: false };
        for (const x of arr) {
          if (x === 'KITCHEN' || x === 'BAR' || x === 'DESSERT') (next as any)[x] = true;
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
        <div className="text-xs opacity-70">Choose which stations exist in your kitchen screens.</div>
        <label className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium">Kitchen</div>
            <div className="text-xs opacity-70">Default station (recommended)</div>
          </div>
          <input
            type="checkbox"
            checked={enabled.KITCHEN}
            onChange={(e) => {
              // Always keep at least one station enabled
              const next = { ...enabled, KITCHEN: e.target.checked };
              if (!next.KITCHEN && !next.BAR && !next.DESSERT) next.KITCHEN = true;
              setEnabled(next);
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <div className="font-medium">Bar</div>
          <input type="checkbox" checked={enabled.BAR} onChange={(e) => setEnabled((s) => ({ ...s, BAR: e.target.checked }))} />
        </label>
        <label className="flex items-center justify-between gap-3">
          <div className="font-medium">Dessert</div>
          <input type="checkbox" checked={enabled.DESSERT} onChange={(e) => setEnabled((s) => ({ ...s, DESSERT: e.target.checked }))} />
        </label>

        <button
          className="px-3 py-2 rounded bg-emerald-700 w-full"
          onClick={async () => {
            setStatus(null);
            try {
              await window.api.settings.update({ kds: { enabledStations } } as any);
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
  const [ip, setIp] = useState('');
  const [testing, setTesting] = useState(false);
  return (
    <div>
      <div className="text-lg font-semibold mb-3">Printer</div>
      <div className="flex items-center gap-2 mb-3">
        <input className="bg-gray-700 rounded px-3 py-2 flex-1" placeholder="Printer IP" value={ip} onChange={(e) => setIp(e.target.value)} />
        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
          onClick={async () => {
            setTesting(true);
            await window.api.settings.testPrint();
            setTesting(false);
          }}
        >
          {testing ? 'Printing…' : 'Test'}
        </button>
      </div>
      <div className="text-xs opacity-70">Configure ESC/POS network printer IP.</div>
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
        <button className="text-blue-500 cursor-pointer" onClick={() => setAreas(arr => [...arr, { name: 'New Area', count: 4 }])}>+</button>
      </div>

      <div className="space-y-2">
        {areas.map((a, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <input className="bg-gray-700 rounded px-2 py-1 flex-1" value={a.name} onChange={(e) => setAreas(arr => arr.map((x, i) => i===idx? { ...x, name: e.target.value }: x))} />
            <input className="w-24 bg-gray-700 rounded px-2 py-1" type="number" min={0} value={a.count} onChange={(e) => setAreas(arr => arr.map((x, i) => i===idx? { ...x, count: Number(e.target.value) }: x))} />
            <button className="p-1 rounded bg-red-600 hover:bg-red-700 cursor-pointer" onClick={() => setAreas(arr => arr.filter((_, i) => i!==idx))}>x</button>
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
  const [status, setStatus] = useState<string | null>(null);
  const [backendUrl, setBackendUrl] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const s = await window.api.settings.get();
        setBackendUrl(String((s as any)?.cloud?.backendUrl || ''));
        setBusinessCode(String((s as any)?.cloud?.businessCode || ''));
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
        <div className="text-xs opacity-70">Backend URL (managed by provider)</div>
        {/* <input className="bg-gray-700 rounded px-3 py-2 w-full opacity-70" value={backendUrl || '(not configured)'} readOnly /> */}
        <input
          className="bg-gray-700 rounded px-3 py-2 w-full"
          placeholder="Business code (e.g.  Code Orbit)"
          value={businessCode}
          onChange={(e) => setBusinessCode(e.target.value.toUpperCase())}
        />
        <button
          className="px-3 py-2 rounded bg-emerald-700 w-full"
          onClick={async () => {
            setStatus(null);
            try {
              const updated = await window.api.settings.update({ cloud: { businessCode } } as any);
              setBackendUrl(String((updated as any)?.cloud?.backendUrl || backendUrl));
              setBusinessCode(String((updated as any)?.cloud?.businessCode || businessCode));
              setStatus('Saved.');
            } catch (e: any) {
              setStatus(e?.message || 'Save failed.');
            }
          }}
        >
          Save Cloud Settings
        </button>
        <div className="text-xs opacity-70">
          When set, the app will use the hosted backend for staff/menu/shifts/tickets (printing remains local).
        </div>
        {status && <div className="text-xs opacity-80">{status}</div>}
      </div>
    </div>
  );
}

function AboutSettings() {
  return (
    <div>
      <div className="text-lg font-semibold mb-3">About</div>
      <div className="opacity-80"> Code Orbit POS — Admin Settings</div>
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
        setRequirePairingCode(Boolean((s as any)?.security?.requirePairingCode ?? true));
        setPairingCode(String((s as any)?.security?.pairingCode || ''));
        setIps(ipList || []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const primaryIp = ips[0] || '';
  const lanUrl = primaryIp ? `http://${primaryIp}:3333/renderer/` : '';

  async function saveSecurity(next: { allowLan?: boolean; requirePairingCode?: boolean; pairingCode?: string }) {
    setStatus(null);
    const updated = await window.api.settings.update({ security: next } as any);
    setAllowLan(Boolean((updated as any)?.security?.allowLan));
    setRequirePairingCode(Boolean((updated as any)?.security?.requirePairingCode ?? true));
    setPairingCode(String((updated as any)?.security?.pairingCode || next.pairingCode || ''));
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
                <div className="text-xs opacity-70">Enables network access to the local API. Requires app restart to take effect.</div>
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
                <div className="text-xs opacity-70">Tablet logins must enter the pairing code shown here.</div>
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
                <input className="bg-gray-700 rounded px-3 py-2 flex-1" value={pairingCode || '(not generated yet)'} readOnly />
                <button
                  className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
                  onClick={async () => {
                    const code = String(Math.floor(100000 + Math.random() * 900000));
                    await saveSecurity({ pairingCode: code });
                  }}
                >
                  Regenerate
                </button>
              </div>
              <div className="text-xs opacity-70 mt-2">Use this code on tablets when logging in.</div>
            </div>

            <div className="mt-3 p-3 rounded bg-gray-900/50 border border-gray-700">
              <div className="text-sm font-semibold mb-2">Tablet URL</div>
              {lanUrl ? (
                <div className="flex items-center gap-2">
                  <input className="bg-gray-700 rounded px-3 py-2 flex-1" value={lanUrl} readOnly />
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
                <div className="text-xs opacity-70">No Wi‑Fi IP detected. Connect to Wi‑Fi or Ethernet and reopen this page.</div>
              )}
              <div className="text-xs opacity-70 mt-2">Open this on the tablet’s browser (same Wi‑Fi).</div>
            </div>

            {status && <div className="text-xs opacity-80 mt-2">{status}</div>}
          </div>
        </>
      )}
    </div>
  );
}


