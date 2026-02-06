import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/session';

export default function ClockPage() {
  const user = useSessionStore((s) => s.user);
  const setUser = useSessionStore((s) => s.setUser);
  const navigate = useNavigate();
  const [open, setOpen] = useState<any>(null);
  const [busy, setBusy] = useState<'in' | 'out' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!user?.id) return;
    const o = await window.api.shifts.getOpen(user.id).catch(() => null);
    setOpen(o);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (!user) return null;

  const isOpen = Boolean(open);
  const openedAt = isOpen ? new Date(open.openedAt).toLocaleString() : '—';

  return (
    <div className="h-full min-h-0 flex items-center justify-center">
      <div className="w-full max-w-xl bg-gray-800 border border-gray-700 rounded-xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-lg font-semibold">Clock in / out</div>
            <div className="text-sm opacity-80">
              Staff: <span className="font-semibold">{user.displayName}</span> • Role:{' '}
              <span className="font-mono">{String((user as any).role || '').toUpperCase()}</span>
            </div>
          </div>
          <button
            className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
            onClick={() => navigate('/')}
            type="button"
          >
            Back to login
          </button>
        </div>

        <div className="bg-gray-900/50 border border-gray-700 rounded-lg p-4 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs opacity-70 mb-1">Shift status</div>
              <div className="text-base font-semibold">{isOpen ? 'OPEN' : 'CLOSED'}</div>
              <div className="text-sm opacity-80 mt-1">Opened at: {openedAt}</div>
            </div>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
              onClick={refresh}
              type="button"
            >
              Refresh
            </button>
          </div>
        </div>

        {err && (
          <div className="mb-4 p-3 rounded bg-rose-900/30 border border-rose-700 text-rose-200 text-sm">
            {err}
          </div>
        )}

        <div className="flex gap-3">
          <button
            className="flex-1 py-3 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60"
            disabled={busy != null || isOpen}
            onClick={async () => {
              if (!user?.id) return;
              setErr(null);
              setBusy('in');
              try {
                await window.api.shifts.clockIn(user.id);
                await refresh();
              } catch (e: any) {
                setErr(e?.message || 'Clock in failed');
              } finally {
                setBusy(null);
              }
            }}
            type="button"
          >
            {busy === 'in' ? 'Clocking in…' : 'Clock in'}
          </button>
          <button
            className="flex-1 py-3 rounded bg-rose-700 hover:bg-rose-600 disabled:opacity-60"
            disabled={busy != null || !isOpen}
            onClick={async () => {
              if (!user?.id) return;
              const ok = window.confirm('Clock out now?');
              if (!ok) return;
              setErr(null);
              setBusy('out');
              try {
                await window.api.shifts.clockOut(user.id);
                // After clock out, log them out so they can't access anything else.
                setUser(null);
                navigate('/');
              } catch (e: any) {
                setErr(e?.message || 'Clock out failed');
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
          Note: kitchen staff accounts are clock-only and cannot access Tables/Orders/Reports.
        </div>
      </div>
    </div>
  );
}

