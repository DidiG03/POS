import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type LicenseStatus = {
  required: boolean;
  licensed: boolean;
  email?: string;
  key?: string;
  status?: string;
  currentPeriodEnd?: string | null;
  message?: string | null;
  billingConfigured?: boolean;
};

export default function LicenseGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const isHost =
    typeof window !== 'undefined' &&
    Boolean((window as any).api?.license) &&
    !(window as any).__BROWSER_CLIENT__ &&
    !(window as any).__KDS_APP__;

  const [status, setStatus] = useState<LicenseStatus | null>(
    isHost ? null : { required: false, licensed: true },
  );
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'pay' | 'restore'>('pay');

  const refresh = useCallback(async () => {
    if (!isHost) return;
    const s = await window.api.license.getStatus();
    setStatus(s);
    if (s?.email) setEmail(String(s.email));
  }, [isHost]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isHost) return;
    const off = window.api.license.onUpdated?.(() => {
      void refresh();
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [isHost, refresh]);

  if (!isHost) return <>{children}</>;
  if (!status) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-950 text-gray-200">
        {t('common.loading')}
      </div>
    );
  }
  if (!status.required || status.licensed) return <>{children}</>;

  async function subscribe() {
    setBusy('pay');
    setErr(null);
    try {
      const r = await window.api.license.createCheckout({
        email: email.trim(),
      });
      if (r?.error) setErr(String(r.error));
      else if (r?.alreadyLicensed) await refresh();
    } catch (e: any) {
      setErr(String(e?.message || t('license.payFailed')));
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    setBusy('key');
    setErr(null);
    try {
      const r = await window.api.license.activateKey({
        key: key.trim(),
      });
      if (!r?.ok) setErr(String(r?.error || t('license.keyInvalid')));
      else await refresh();
    } catch (e: any) {
      setErr(String(e?.message || t('license.keyInvalid')));
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy('restore');
    setErr(null);
    try {
      const r = await window.api.license.restore({
        email: email.trim(),
      });
      if (!r?.ok)
        setErr(String(r?.error || r?.message || t('license.restoreFailed')));
      else await refresh();
    } catch (e: any) {
      setErr(String(e?.message || t('license.restoreFailed')));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-gray-950 text-gray-100 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-5 space-y-4">
        <div>
          <div className="text-lg font-semibold">{t('license.title')}</div>
          <div className="text-sm opacity-80 mt-1">{t('license.body')}</div>
        </div>
        {status.message && (
          <div className="text-xs text-amber-200/90">{status.message}</div>
        )}
        <label className="block text-sm">
          <div className="mb-1 opacity-80">{t('license.email')}</div>
          <input
            className="w-full bg-gray-800 rounded px-3 py-2"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@restaurant.com"
          />
        </label>
        {mode === 'pay' ? (
          <button
            className="w-full px-3 py-2 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50"
            disabled={Boolean(busy) || !email.includes('@')}
            type="button"
            onClick={() => void subscribe()}
          >
            {busy === 'pay'
              ? t('license.openingStripe')
              : t('license.subscribe')}
          </button>
        ) : (
          <button
            className="w-full px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
            disabled={Boolean(busy) || !email.includes('@')}
            type="button"
            onClick={() => void restore()}
          >
            {busy === 'restore' ? t('common.loading') : t('license.restore')}
          </button>
        )}
        <button
          className="text-xs opacity-80 underline"
          type="button"
          onClick={() => setMode(mode === 'pay' ? 'restore' : 'pay')}
        >
          {mode === 'pay' ? t('license.alreadyPaid') : t('license.needToPay')}
        </button>
        <div className="border-t border-gray-700 pt-3 space-y-2">
          <div className="text-xs opacity-70">{t('license.pasteKey')}</div>
          <input
            className="w-full bg-gray-800 rounded px-3 py-2 font-mono text-xs"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="POS1...."
          />
          <button
            className="w-full px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
            disabled={Boolean(busy) || key.trim().length < 8}
            type="button"
            onClick={() => void activate()}
          >
            {busy === 'key' ? t('common.loading') : t('license.activateKey')}
          </button>
        </div>
        {err && <div className="text-sm text-rose-300">{err}</div>}
      </div>
    </div>
  );
}
