import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/session';

type Station = 'KITCHEN' | 'BAR' | 'DESSERT';
type Tab = 'NEW' | 'DONE';

type KdsTicket = {
  ticketId: number;
  orderNo: number;
  area: string;
  tableLabel: string;
  firedAt: string;
  bumpedAt?: string | null;
  note?: string | null;
  items: Array<{
    name: string;
    qty?: number;
    note?: string;
    station?: Station;
    _idx?: number;
    bumped?: boolean;
  }>;
};

function nowMs() {
  return Date.now();
}

function fmtAgo(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((nowMs() - t) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm < 60) return `${mm}:${String(ss).padStart(2, '0')}`;
  const hh = Math.floor(mm / 60);
  const rem = mm % 60;
  return `${hh}h ${rem}m`;
}

export default function KdsPage() {
  const user = useSessionStore((s) => s.user);
  const setUser = useSessionStore((s) => s.setUser);
  const [enabledStations, setEnabledStations] = useState<Station[]>([
    'KITCHEN',
  ]);
  const [station, setStation] = useState<Station>('KITCHEN');
  const [tab, setTab] = useState<Tab>('NEW');
  const [tickets, setTickets] = useState<KdsTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [debug, setDebug] = useState<any>(null);
  const bumping = useRef<Set<number>>(new Set());
  const [itemMenu, setItemMenu] = useState<null | {
    x: number;
    y: number;
    ticketId: number;
    itemIdx: number;
    name: string;
  }>(null);
  const longPressTimer = useRef<any>(null);
  const errRef = useRef<string | null>(null);
  useEffect(() => {
    errRef.current = err;
  }, [err]);

  useEffect(() => {
    (async () => {
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        const raw = (s as any)?.kds?.enabledStations;
        const arr = (Array.isArray(raw) ? raw : ['KITCHEN']).map((x: any) =>
          String(x).toUpperCase(),
        );
        const uniq = Array.from(new Set(arr)).filter(
          (x) => x === 'KITCHEN' || x === 'BAR' || x === 'DESSERT',
        ) as Station[];
        const next = uniq.length ? uniq : (['KITCHEN'] as Station[]);
        setEnabledStations(next);
        if (!next.includes(station)) setStation(next[0]);
      } catch {
        // ignore
      }
    })();
    // Empty deps array is intentional - only run on mount
  }, []);

  const title = useMemo(() => {
    const s =
      station === 'KITCHEN' ? 'Kitchen' : station === 'BAR' ? 'Bar' : 'Dessert';
    return `${s} Display`;
  }, [station]);

  useEffect(() => {
    let alive = true;
    let pollTimer: any = null;
    let debugTimer: any = null;

    const POLL_MS = 3000; // reduce churn vs 2s
    const DEBUG_MS = 30000; // debug is expensive; don't fetch every poll

    const loadTickets = async () => {
      if (!alive) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (errRef.current) setErr(null);
      try {
        const rows = (await window.api.kds.listTickets({
          station,
          status: tab,
          limit: tab === 'NEW' ? 120 : 80,
        })) as any;
        if (!alive) return;
        setTickets(Array.isArray(rows) ? (rows as KdsTicket[]) : []);
        setLoading(false);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || 'Failed to load KDS tickets');
        setLoading(false);
      }
    };

    const loadDebug = async () => {
      if (!alive) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const dbg = await window.api.kds.debug().catch(() => null);
      if (!alive) return;
      setDebug(dbg);
    };

    const start = () => {
      if (pollTimer) return;
      void loadTickets();
      void loadDebug();
      pollTimer = setInterval(loadTickets, POLL_MS);
      debugTimer = setInterval(loadDebug, DEBUG_MS);
    };

    const stop = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (debugTimer) clearInterval(debugTimer);
      pollTimer = null;
      debugTimer = null;
    };

    const onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') stop();
      else start();
    };

    start();
    try {
      document.addEventListener('visibilitychange', onVis);
    } catch {
      // ignore
    }

    return () => {
      alive = false;
      stop();
      try {
        document.removeEventListener('visibilitychange', onVis);
      } catch {
        // ignore
      }
    };
  }, [station, tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setItemMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-full min-h-screen bg-gray-950 text-gray-100 p-4">
      <div className="flex items-center justify-between gap-4 mb-3">
        <div>
          <div className="text-xl font-semibold">{title}</div>
          <div className="text-xs opacity-70">
            {tab === 'NEW'
              ? 'Active tickets (tap Bump to mark DONE)'
              : 'Recently bumped tickets'}
          </div>
          {debug && (
            <div className="mt-1 text-[11px] opacity-60">
              debug: schema={String(debug?.schemaReady)} tickets=
              {String(debug?.counts?.kdsTickets ?? '?')} stations=
              {String(debug?.counts?.kdsStations ?? '?')} ticketLog=
              {String(debug?.counts?.ticketLog ?? '?')}
              {debug?.lastError ? ` · err=${String(debug.lastError)}` : ''}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <button
              className="px-3 py-2 rounded bg-gray-900 hover:bg-gray-800 border border-gray-800 text-sm"
              onClick={() => {
                setUser(null);
                try {
                  window.location.hash = '#/';
                } catch {
                  /* ignore */
                }
              }}
              title="Switch user"
            >
              Logout
            </button>
          ) : (
            <button
              className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800 border border-emerald-600 text-sm"
              onClick={() => {
                try {
                  window.location.hash = '#/';
                } catch {
                  /* ignore */
                }
              }}
              title="Login to enable bump attribution"
            >
              Login
            </button>
          )}
          <div className="flex rounded overflow-hidden border border-gray-800">
            {enabledStations.map((st) => (
              <button
                key={st}
                className={`px-3 py-2 text-sm ${station === st ? 'bg-gray-800' : 'bg-gray-900 hover:bg-gray-800'}`}
                onClick={() => setStation(st)}
              >
                {st === 'KITCHEN'
                  ? 'Kitchen'
                  : st === 'BAR'
                    ? 'Bar'
                    : 'Dessert'}
              </button>
            ))}
          </div>

          <div className="flex rounded overflow-hidden border border-gray-800">
            <button
              className={`px-3 py-2 text-sm ${tab === 'NEW' ? 'bg-emerald-700' : 'bg-gray-900 hover:bg-gray-800'}`}
              onClick={() => setTab('NEW')}
            >
              NEW
            </button>
            <button
              className={`px-3 py-2 text-sm ${tab === 'DONE' ? 'bg-gray-800' : 'bg-gray-900 hover:bg-gray-800'}`}
              onClick={() => setTab('DONE')}
            >
              Done
            </button>
          </div>
        </div>
      </div>

      {loading && <div className="opacity-70">Loading…</div>}
      {err && (
        <div className="mb-3 p-3 rounded bg-rose-900/30 border border-rose-700 text-rose-200 text-sm">
          {err}
        </div>
      )}

      {tickets.length === 0 && !loading ? (
        <div className="opacity-70 text-sm">No tickets.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {tickets.map((t) => (
            <div
              key={`${station}-${tab}-${t.ticketId}`}
              className="bg-gray-900 border border-gray-800 rounded p-3"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="text-2xl font-bold">Order #{t.orderNo}</div>
                  <div className="text-xs opacity-70">
                    {t.area} · {t.tableLabel} ·{' '}
                    {tab === 'NEW'
                      ? `Age ${fmtAgo(t.firedAt)}`
                      : t.bumpedAt
                        ? `Bumped ${fmtAgo(t.bumpedAt)} ago`
                        : ''}
                  </div>
                </div>
                {tab === 'NEW' && (
                  <button
                    className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60"
                    disabled={bumping.current.has(t.ticketId)}
                    onClick={async () => {
                      if (bumping.current.has(t.ticketId)) return;
                      bumping.current.add(t.ticketId);
                      // Optimistic remove
                      setTickets((arr) =>
                        arr.filter((x) => x.ticketId !== t.ticketId),
                      );
                      const ok = await window.api.kds
                        .bump({
                          station,
                          ticketId: t.ticketId,
                          ...(user?.id ? { userId: user.id } : {}),
                        })
                        .catch(() => false);
                      bumping.current.delete(t.ticketId);
                      if (!ok) {
                        // Put it back if failed
                        setTickets((arr) => [t, ...arr]);
                      }
                    }}
                  >
                    Bump
                  </button>
                )}
              </div>

              {t.note && (
                <div className="mb-2 text-sm bg-gray-950 border border-gray-800 rounded p-2">
                  {t.note}
                </div>
              )}

              <div className="space-y-1">
                {t.items.map((it, idx) => (
                  <div
                    key={idx}
                    className="flex items-start justify-between gap-2 text-sm select-none"
                    onContextMenu={(e) => {
                      if (tab !== 'NEW') return;
                      e.preventDefault();
                      const itemIdx = Number((it as any)?._idx ?? -1);
                      if (!Number.isFinite(itemIdx) || itemIdx < 0) return;
                      setItemMenu({
                        x: e.clientX,
                        y: e.clientY,
                        ticketId: t.ticketId,
                        itemIdx,
                        name: String(it.name || ''),
                      });
                    }}
                    onPointerDown={(e) => {
                      if (tab !== 'NEW') return;
                      // Long-press on touch/pen opens menu
                      const pt = (e as any).pointerType;
                      if (pt !== 'touch' && pt !== 'pen') return;
                      const itemIdx = Number((it as any)?._idx ?? -1);
                      if (!Number.isFinite(itemIdx) || itemIdx < 0) return;
                      if (longPressTimer.current)
                        clearTimeout(longPressTimer.current);
                      longPressTimer.current = setTimeout(() => {
                        setItemMenu({
                          x: (e as any).clientX || 20,
                          y: (e as any).clientY || 20,
                          ticketId: t.ticketId,
                          itemIdx,
                          name: String(it.name || ''),
                        });
                      }, 550);
                    }}
                    onPointerUp={() => {
                      if (longPressTimer.current)
                        clearTimeout(longPressTimer.current);
                      longPressTimer.current = null;
                    }}
                    onPointerLeave={() => {
                      if (longPressTimer.current)
                        clearTimeout(longPressTimer.current);
                      longPressTimer.current = null;
                    }}
                  >
                    <div className="font-medium">
                      {it.name}
                      {it.note ? (
                        <span className="opacity-70"> · {it.note}</span>
                      ) : null}
                    </div>
                    <div className="opacity-80">{Number(it.qty || 1)}x</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {itemMenu && (
        <div
          className="fixed inset-0 z-50"
          onMouseDown={() => setItemMenu(null)}
          onTouchStart={() => setItemMenu(null)}
        >
          <div
            className="absolute bg-gray-900 border border-gray-700 rounded shadow-xl p-2 min-w-[180px]"
            style={{
              left: Math.min(itemMenu.x, window.innerWidth - 220),
              top: Math.min(itemMenu.y, window.innerHeight - 120),
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            <div className="text-xs opacity-70 px-2 py-1 truncate">
              {itemMenu.name || 'Item'}
            </div>
            <button
              className="w-full text-left px-2 py-2 rounded hover:bg-gray-800"
              onClick={async () => {
                const { ticketId, itemIdx } = itemMenu;
                setItemMenu(null);
                // Optimistic: remove item from UI immediately
                setTickets((arr) =>
                  arr
                    .map((t) =>
                      t.ticketId !== ticketId
                        ? t
                        : {
                            ...t,
                            items: t.items.filter(
                              (x: any) =>
                                Number((x as any)?._idx ?? -1) !== itemIdx,
                            ),
                          },
                    )
                    .filter((t) => (tab === 'NEW' ? t.items.length > 0 : true)),
                );
                await window.api.kds
                  .bumpItem({
                    station,
                    ticketId,
                    itemIdx,
                    ...(user?.id ? { userId: user.id } : {}),
                  } as any)
                  .catch(() => false);
              }}
            >
              Bump item
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
