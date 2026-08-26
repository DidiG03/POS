/**
 * First-run / re-pair screen for the standalone "Code Orbit KDS" app.
 *
 * Flow:
 *   1. Auto-discover POS hosts on the LAN (mDNS + HTTP scan of this Wi-Fi).
 *   2. If several tills answer, the user picks one. If only one answers,
 *      it is selected automatically. Manual IP remains as a fallback.
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
import { PosHostPicker } from '../components/PosHostPicker';
import type { DiscoveredPosHost } from '@shared/posHostDiscovery';

type DiscoveredHost = DiscoveredPosHost;

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
      const raw = await api.discover();
      const list = Array.isArray(raw) ? raw : [];
      setHosts(list);
      if (list.length === 1) {
        setHost(list[0].host);
        setHttpPort(String(list[0].httpPort || 3333));
        setResult(`Found ${list[0].name}. Save to connect, or rescan.`);
        setResultOk(true);
      } else if (list.length > 1) {
        setHost('');
        setResult(
          `${list.length} POS hosts found. Tap the one this kitchen display should use.`,
        );
        setResultOk(true);
      } else {
        setResult(
          'No POS hosts answered the scan. Make sure the POS app is running on the same Wi-Fi, then tap Rescan — or type the IP below.',
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
      const test = await api.testConnection({
        host: trimmedHost,
        httpPort: port,
      });
      if (!test.ok) {
        setResult(
          test.error?.includes('403') || test.error?.includes('ECONNREFUSED')
            ? `${test.error} — On the POS host, open Admin → Settings → LAN / Tablets and turn on "Allow LAN access", then restart POS.`
            : test.error || 'Connection failed. Click Test connection first.',
        );
        setResultOk(false);
        return;
      }
      await persistKdsBackendHost({ host: trimmedHost, httpPort: port });
      // Main process navigates to #/kds after save.
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
            We look for POS tills on this Wi-Fi. If more than one is found, tap
            the one this kitchen display should use.
          </p>
        </div>

        {!api && (
          <div className="bg-amber-900/30 border border-amber-700 rounded p-3 text-sm">
            This screen is meant for the standalone KDS app. Auto-discovery
            isn’t available here.
          </div>
        )}

        <PosHostPicker
          hosts={hosts}
          selectedHost={host}
          selectedPort={httpPort}
          scanning={scanning}
          onSelect={(h) => {
            setHost(h.host);
            setHttpPort(String(h.httpPort || 3333));
            setResult(null);
          }}
          onRescan={() => void scan()}
          labels={{
            title: 'POS hosts on this network',
            scanning: 'Looking for POS…',
            empty: 'No hosts found yet.',
            rescan: 'Rescan',
          }}
        />

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
