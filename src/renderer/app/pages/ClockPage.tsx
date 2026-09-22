import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { reportAppError } from '../../utils/reportAppError';
import { isClockCaptureEnabled } from '@shared/clockCapture';
import { clockCaptureFromChange } from '@shared/settingsChange';
import { useSessionStore } from '../../stores/session';

export default function ClockPage() {
  const user = useSessionStore((s) => s.user);
  const setUser = useSessionStore((s) => s.setUser);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [open, setOpen] = useState<any>(null);
  const [captureClock, setCaptureClock] = useState(false);
  const [busy, setBusy] = useState<'in' | 'out' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!user?.id) return;
    const [o, settings] = await Promise.all([
      window.api.shifts.getOpen(user.id).catch(() => null),
      window.api.settings.get().catch(() => null),
    ]);
    setOpen(o);
    if (settings) setCaptureClock(isClockCaptureEnabled(settings));
  }

  useEffect(() => {
    void refresh();
  }, [user?.id]);

  useEffect(() => {
    const onSettings = (ev: Event) => {
      const clock = clockCaptureFromChange((ev as CustomEvent).detail);
      if (clock != null) setCaptureClock(clock);
    };
    window.addEventListener('pos:settingsChanged', onSettings);
    return () => window.removeEventListener('pos:settingsChanged', onSettings);
  }, []);

  if (!user) return null;

  const isOpen = Boolean(open);
  const openedAt = isOpen ? new Date(open.openedAt).toLocaleString() : '—';

  return (
    <div className="h-full min-h-0 flex items-center justify-center">
      <div className="w-full max-w-xl pos-surface-panel p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-lg font-semibold tracking-tight">
              Clock in / out
            </div>
            <div className="text-sm text-gray-400 mt-0.5">
              Staff:{' '}
              <span className="font-semibold text-gray-100">
                {user.displayName}
              </span>{' '}
              • Role:{' '}
              <span className="font-mono text-gray-300">
                {String((user as any).role || '').toUpperCase()}
              </span>
            </div>
          </div>
          <button
            className="pos-btn text-sm"
            onClick={() => navigate('/')}
            type="button"
          >
            Back to login
          </button>
        </div>

        <div className="pos-stat mb-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs opacity-70 mb-1">Shift status</div>
              <div className="text-base font-semibold">
                {isOpen ? 'OPEN' : 'CLOSED'}
              </div>
              <div className="text-sm opacity-80 mt-1">
                Opened at: {openedAt}
              </div>
            </div>
            <button className="pos-btn text-sm" onClick={refresh} type="button">
              Refresh
            </button>
          </div>
        </div>

        {!captureClock ? (
          <div className="mb-4 p-3 rounded-lg border border-white/10 bg-white/5 text-sm text-gray-300">
            <div className="font-medium text-gray-100">
              {t('layout.clockCaptureOff')}
            </div>
            <div className="mt-1 text-gray-400">
              {t('layout.clockCaptureOffBody')}
            </div>
          </div>
        ) : null}

        {err && (
          <div className="mb-4 p-3 rounded bg-rose-900/30 border border-rose-700 text-rose-200 text-sm">
            {err}
          </div>
        )}

        <div className="flex gap-3">
          <button
            className="flex-1 pos-btn-primary py-3 text-base disabled:opacity-60"
            disabled={busy != null || isOpen || !captureClock}
            onClick={async () => {
              if (!user?.id) return;
              setErr(null);
              setBusy('in');
              try {
                const r: any = await window.api.shifts.clockIn(user.id);
                if (r?.ok === false && r?.code === 'SHIFT_REOPEN_BLOCKED') {
                  const when = (() => {
                    try {
                      return new Date(
                        String(r.reopenAt || ''),
                      ).toLocaleString();
                    } catch {
                      return String(r.reopenAt || '');
                    }
                  })();
                  setErr(t('layout.shiftReopenBlocked', { when }));
                  return;
                }
                await refresh();
              } catch (e: any) {
                setErr(e?.message || 'Clock in failed');
                reportAppError(e, {
                  fallback: t('layout.clockInFailed'),
                  key: `shifts.clockIn:${user.id}`,
                });
              } finally {
                setBusy(null);
              }
            }}
            type="button"
          >
            {busy === 'in' ? 'Clocking in…' : 'Clock in'}
          </button>
          <button
            className="flex-1 rounded-lg bg-rose-700 py-3 text-base font-semibold text-white transition-colors hover:bg-rose-600 disabled:opacity-60"
            disabled={busy != null || !isOpen || !captureClock}
            onClick={async () => {
              if (!user?.id) return;
              const ok = window.confirm('Clock out now?');
              if (!ok) return;
              setErr(null);
              setBusy('out');
              try {
                const r: any = await window.api.shifts.clockOut(user.id);
                // Server may now respond with a structured rejection
                // when the waiter still owns open tables — surface a
                // clear message and abort the logout so they don't
                // walk away with their tables stranded.
                if (r && typeof r === 'object' && r.ok === false) {
                  setErr(String(r.error || 'You still have open tables.'));
                  return;
                }
                // After clock out, log them out so they can't access anything else.
                setUser(null);
                navigate('/');
              } catch (e: any) {
                setErr(e?.message || 'Clock out failed');
                reportAppError(e, {
                  fallback: t('layout.clockOutFailed'),
                  key: `shifts.clockOut:${user.id}`,
                });
              } finally {
                setBusy(null);
              }
            }}
            type="button"
          >
            {busy === 'out' ? 'Clocking out…' : 'Clock out'}
          </button>
        </div>

        <div className="mt-4 text-xs opacity-70">
          Note: kitchen staff accounts are clock-only and cannot access
          Tables/Orders/Reports.
        </div>
      </div>
    </div>
  );
}
