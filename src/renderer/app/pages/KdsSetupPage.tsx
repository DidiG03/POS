/**
 * First-run / re-pair screen for the standalone "Code Orbit KDS" app.
 *
 * Flow:
 *   1. Auto-discover POS hosts on the LAN via mDNS (handled in the KDS
 *      main process; we just call `window.kdsApp.discover()`).
 *   2. The user can pick one, or type a host manually.
 *   3. "Test connection" hits `/kds/debug` on the host to confirm it
 *      responds before we save.
 *   4. On save, the main process rewrites the saved config and
 *      navigates the window to `#/kds`.
 *
 * If the renderer is loaded outside the KDS Electron app (e.g. someone
 * opened the URL in a browser) `window.kdsApp` is undefined; we degrade
 * gracefully to a manual-only form.
 */
import { useCallback, useEffect, useState } from 'react';
import { persistKdsBackendHost } from '@renderer/utils/backendHost';

type DiscoveredHost = {
  name?: string;
  host: string;
  httpPort: number;
  httpsPort?: number;
  addresses: string[];
  businessCode?: string;
};

type KdsAppApi = {
  getConfig: () => Promise<any>;
  saveConfig: (cfg: {
    host: string;
    httpPort: number;
    httpsPort?: number;
    businessCode?: string;
  }) => Promise<any>;
  resetConfig: () => Promise<boolean>;
  discover: () => Promise<DiscoveredHost[]>;
  testConnection: (input: {
    host: string;
    httpPort: number;
  }) => Promise<{ ok: true; body?: any } | { ok: false; error: string }>;
};

function getKdsApi(): KdsAppApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as any).kdsApp as KdsAppApi | undefined;
  return api && typeof api.saveConfig === 'function' ? api : null;
}

export default function KdsSetupPage() {
  const api = getKdsApi();
  const [host, setHost] = useState('');
  const [httpPort, setHttpPort] = useState('3333');
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultOk, setResultOk] = useState<boolean | null>(null);

  const scan = useCallback(async () => {
    if (!api) return;
    setScanning(true);
    setResult(null);
    setResultOk(null);
    try {
      const list = await api.discover();
      setHosts(Array.isArray(list) ? list : []);
      if (list && list.length === 1) {
        setHost(list[0].host);
        setHttpPort(String(list[0].httpPort || 3333));
      }
      if (!list || list.length === 0) {
        setResult(
          'No POS hosts answered the scan. Make sure the POS app is running on the same Wi-Fi.',
        );
        setResultOk(false);
      }
    } catch (e: any) {
      setResult(e?.message || 'Scan failed.');
      setResultOk(false);
    } finally {
      setScanning(false);
    }
  }, [api]);

  useEffect(() => {
    void scan();
  }, [scan]);

  async function test() {
    if (!api) return;
    if (!host.trim()) {
      setResult('Enter a host first.');
      setResultOk(false);
      return;
    }
    setTesting(true);
    setResult(null);
    setResultOk(null);
    try {
      const r = await api.testConnection({
        host: host.trim(),
        httpPort: Number(httpPort) || 3333,
      });
      if (r.ok) {
        setResult('Connected. POS host is reachable.');
        setResultOk(true);
      } else {
        setResult(r.error || 'Connection failed.');
        setResultOk(false);
      }
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!api) return;
    if (!host.trim()) {
      setResult('Enter a host first.');
      setResultOk(false);
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const trimmedHost = host.trim();
      const port = Number(httpPort) || 3333;
      await persistKdsBackendHost({ host: trimmedHost, httpPort: port });
      // Main process reloads the window after save.
    } catch (e: any) {
      setResult(e?.message || 'Could not save configuration.');
      setResultOk(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl bg-gray-800 border border-gray-700 rounded-xl shadow-2xl p-6 space-y-5">
        <div>
          <div className="text-xs uppercase tracking-wide opacity-60">
            Code Orbit KDS
          </div>
          <h1 className="text-xl font-semibold mt-1">Connect to your POS</h1>
          <p className="text-sm opacity-80 mt-1">
            This kitchen display needs to know where your POS host is on the
            network. Pick one we found, or type the IP address manually.
          </p>
        </div>

        {!api && (
          <div className="bg-amber-900/30 border border-amber-700 rounded p-3 text-sm">
            This screen is meant for the standalone KDS app. Auto-discovery
            isn’t available here.
          </div>
        )}

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium opacity-90">
              POS hosts on this network
            </div>
            <button
              type="button"
              disabled={!api || scanning}
              onClick={() => void scan()}
              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-xs disabled:opacity-60"
            >
              {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          </div>
          <div className="rounded border border-gray-700 divide-y divide-gray-700 max-h-48 overflow-y-auto">
            {scanning && hosts.length === 0 ? (
              <div className="p-3 text-sm opacity-70">Looking for hosts…</div>
            ) : hosts.length === 0 ? (
              <div className="p-3 text-sm opacity-70">No hosts found yet.</div>
            ) : (
              hosts.map((h) => (
                <button
                  key={`${h.host}:${h.httpPort}`}
                  type="button"
                  onClick={() => {
                    setHost(h.host);
                    setHttpPort(String(h.httpPort || 3333));
                  }}
                  className={`w-full text-left p-3 hover:bg-gray-700/60 ${
                    host === h.host && String(httpPort) === String(h.httpPort)
                      ? 'bg-emerald-900/30'
                      : ''
                  }`}
                >
                  <div className="text-sm font-medium truncate">
                    {h.name || 'Code Orbit POS'}
                  </div>
                  <div className="text-xs opacity-70 font-mono">
                    {h.host}:{h.httpPort}
                  </div>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="space-y-3">
          <div className="text-sm font-medium opacity-90">Manual entry</div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block col-span-2">
              <div className="text-xs opacity-70 mb-1">Host (IP or name)</div>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.50"
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base font-mono"
              />
            </label>
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Port</div>
              <input
                type="text"
                inputMode="numeric"
                value={httpPort}
                onChange={(e) => setHttpPort(e.target.value)}
                placeholder="3333"
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base font-mono"
              />
            </label>
          </div>
        </section>

        {result && (
          <div
            className={`text-sm rounded p-3 border ${
              resultOk === true
                ? 'bg-emerald-900/30 border-emerald-700 text-emerald-100'
                : resultOk === false
                  ? 'bg-rose-900/30 border-rose-700 text-rose-100'
                  : 'bg-gray-700/40 border-gray-600 text-gray-100'
            }`}
          >
            {result}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap pt-2">
          <button
            type="button"
            disabled={!api || testing || !host.trim()}
            onClick={() => void test()}
            className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            disabled={!api || saving || !host.trim()}
            onClick={() => void save()}
            className="ml-auto px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 font-medium"
          >
            {saving ? 'Saving…' : 'Save and continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
