import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import logo512 from '../../../../public/logo512.png';
import {
  kdsBumpBarActionFromEvent,
  type KdsBumpBarAction,
} from '../../utils/kdsBumpBar';

type Station = 'KITCHEN' | 'BAR' | 'DESSERT';
type Tab = 'NEW' | 'DONE';

type KdsTicket = {
  ticketId: number;
  orderNo: number;
  area: string;
  tableLabel: string;
  waiterName?: string | null;
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
    voided?: boolean;
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

function navigableItemIndices(
  ticket: KdsTicket | undefined,
  mode: 'new' | 'done' = 'new',
): number[] {
  if (!ticket) return [];
  return ticket.items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => {
      if (it.voided) return false;
      if (mode === 'done') return true;
      return !it.bumped;
    })
    .map(({ i }) => i);
}

function markItemBumped(ticket: KdsTicket, itemListIdx: number): KdsTicket {
  return {
    ...ticket,
    items: ticket.items.map((x, i) =>
      i === itemListIdx
        ? { ...x, bumped: true, bumpedAt: new Date().toISOString() }
        : x,
    ),
  };
}

function hasActiveItems(ticket: KdsTicket): boolean {
  return ticket.items.some((it) => !it.voided && !it.bumped);
}

export default function KdsPage() {
  const [station, setStation] = useState<Station>('KITCHEN');
  const [tab, setTab] = useState<Tab>('NEW');
  const [tickets, setTickets] = useState<KdsTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const bumping = useRef<Set<number>>(new Set());
  const errRef = useRef<string | null>(null);
  const ticketsRef = useRef<KdsTicket[]>([]);
  const tabRef = useRef<Tab>('NEW');
  const stationRef = useRef<Station>('KITCHEN');
  const selectedIdxRef = useRef(0);
  const selectedItemIdxRef = useRef<number | null>(null);
  const ticketListRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [selectedItemIdx, setSelectedItemIdx] = useState<number | null>(null);
  useEffect(() => {
    errRef.current = err;
  }, [err]);
  useEffect(() => {
    ticketsRef.current = tickets;
    if (tickets.length === 0) {
      setSelectedIdx(0);
      selectedIdxRef.current = 0;
      setSelectedItemIdx(null);
      selectedItemIdxRef.current = null;
      return;
    }
    if (selectedIdxRef.current >= tickets.length) {
      const next = tickets.length - 1;
      setSelectedIdx(next);
      selectedIdxRef.current = next;
      setSelectedItemIdx(null);
      selectedItemIdxRef.current = null;
    }
  }, [tickets]);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  useEffect(() => {
    stationRef.current = station;
  }, [station]);
  useEffect(() => {
    selectedIdxRef.current = selectedIdx;
  }, [selectedIdx]);
  useEffect(() => {
    selectedItemIdxRef.current = selectedItemIdx;
  }, [selectedItemIdx]);
  useEffect(() => {
    setSelectedIdx(0);
    selectedIdxRef.current = 0;
    setSelectedItemIdx(null);
    selectedItemIdxRef.current = null;
  }, [tab, station]);

  const clearItemSelection = useCallback(() => {
    setSelectedItemIdx(null);
    selectedItemIdxRef.current = null;
  }, []);

  const bumpTicket = useCallback(
    async (ticket: KdsTicket) => {
      if (tabRef.current !== 'NEW') return;
      if (bumping.current.has(ticket.ticketId)) return;
      bumping.current.add(ticket.ticketId);
      setTickets((arr) => arr.filter((x) => x.ticketId !== ticket.ticketId));
      clearItemSelection();
      const ok = await window.api.kds
        .bump({
          station: stationRef.current,
          ticketId: ticket.ticketId,
        })
        .catch(() => false);
      bumping.current.delete(ticket.ticketId);
      if (!ok) {
        setTickets((arr) => [ticket, ...arr]);
      }
    },
    [clearItemSelection],
  );

  const bumpItem = useCallback(
    async (ticket: KdsTicket, itemListIdx: number) => {
      if (tabRef.current !== 'NEW') return;
      const it = ticket.items[itemListIdx];
      if (!it || it.voided || it.bumped) return;
      const itemIdx = Number(it._idx ?? -1);
      if (!Number.isFinite(itemIdx) || itemIdx < 0) return;

      const ticketId = ticket.ticketId;
      setTickets((arr) =>
        arr
          .map((t) =>
            t.ticketId !== ticketId ? t : markItemBumped(t, itemListIdx),
          )
          .filter((t) => hasActiveItems(t)),
      );
      clearItemSelection();

      await window.api.kds
        .bumpItem({
          station: stationRef.current,
          ticketId,
          itemIdx,
        } as any)
        .catch(() => false);
    },
    [clearItemSelection],
  );

  const bumpTicketRef = useRef(bumpTicket);
  const bumpItemRef = useRef(bumpItem);

  useEffect(() => {
    bumpTicketRef.current = bumpTicket;
  }, [bumpTicket]);
  useEffect(() => {
    bumpItemRef.current = bumpItem;
  }, [bumpItem]);

  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;

    const refocus = () => {
      if (!document.hasFocus()) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        active.blur();
      }
      if (document.activeElement !== root) {
        root.focus({ preventScroll: true });
      }
    };

    refocus();
    window.addEventListener('focus', refocus);
    document.addEventListener('pointerdown', refocus);
    const timer = window.setInterval(refocus, 4000);

    return () => {
      window.removeEventListener('focus', refocus);
      document.removeEventListener('pointerdown', refocus);
      window.clearInterval(timer);
    };
  }, []);

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

    const POLL_MS = 3000; // reduce churn vs 2s

    const loadTickets = async () => {
      if (!alive) return;
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return;
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

    const start = () => {
      if (pollTimer) return;
      void loadTickets();
      pollTimer = setInterval(loadTickets, POLL_MS);
    };

    const stop = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const onVis = () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        stop();
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
    const itemNavMode = (): 'new' | 'done' =>
      tabRef.current === 'DONE' ? 'done' : 'new';

    const scrollSelectedIntoView = (idx: number) => {
      const root = ticketListRef.current;
      if (!root) return;
      const card = root.querySelector(`[data-kds-ticket-idx="${idx}"]`);
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    const syncItemSelection = (next: number | null) => {
      setSelectedItemIdx(next);
      selectedItemIdxRef.current = next;
    };

    const applyTab = (next: Tab) => {
      tabRef.current = next;
      setTab(next);
    };

    const dispatchBumpBarAction = (action: KdsBumpBarAction) => {
      pageRef.current?.focus({ preventScroll: true });

      const list = ticketsRef.current;
      const maxIdx = Math.max(0, list.length - 1);

      switch (action.type) {
        case 'dismiss':
          return;
        case 'showDone':
          applyTab('DONE');
          setSelectedIdx(0);
          selectedIdxRef.current = 0;
          syncItemSelection(null);
          return;
        case 'showNew':
          applyTab('NEW');
          setSelectedIdx(0);
          selectedIdxRef.current = 0;
          syncItemSelection(null);
          return;
        case 'selectFirst':
          applyTab('NEW');
          setSelectedIdx(0);
          selectedIdxRef.current = 0;
          syncItemSelection(null);
          scrollSelectedIntoView(0);
          return;
        case 'selectNext': {
          const next = list.length
            ? Math.min(maxIdx, selectedIdxRef.current + 1)
            : 0;
          setSelectedIdx(next);
          selectedIdxRef.current = next;
          syncItemSelection(null);
          scrollSelectedIntoView(next);
          return;
        }
        case 'selectPrev': {
          const prev = list.length
            ? Math.max(0, selectedIdxRef.current - 1)
            : 0;
          setSelectedIdx(prev);
          selectedIdxRef.current = prev;
          syncItemSelection(null);
          scrollSelectedIntoView(prev);
          return;
        }
        case 'selectItemNext': {
          const ticket = list[selectedIdxRef.current];
          const nav = navigableItemIndices(ticket, itemNavMode());
          if (nav.length === 0) return;
          const current = selectedItemIdxRef.current;
          if (current === null) {
            syncItemSelection(nav[0]);
            return;
          }
          const pos = nav.indexOf(current);
          if (pos >= 0 && pos < nav.length - 1) {
            syncItemSelection(nav[pos + 1]);
          }
          return;
        }
        case 'selectItemPrev': {
          const ticket = list[selectedIdxRef.current];
          const nav = navigableItemIndices(ticket, itemNavMode());
          if (nav.length === 0) return;
          const current = selectedItemIdxRef.current;
          if (current === null) {
            syncItemSelection(nav[nav.length - 1]);
            return;
          }
          const pos = nav.indexOf(current);
          if (pos > 0) {
            syncItemSelection(nav[pos - 1]);
          } else if (pos === 0) {
            syncItemSelection(null);
          }
          return;
        }
        case 'scrollUp':
          ticketListRef.current?.scrollBy({ top: -320, behavior: 'smooth' });
          return;
        case 'scrollDown':
          ticketListRef.current?.scrollBy({ top: 320, behavior: 'smooth' });
          return;
        case 'bumpSlot': {
          if (tabRef.current !== 'NEW') return;
          const ticket = list[action.slot - 1];
          if (ticket) void bumpTicketRef.current(ticket);
          return;
        }
        case 'bumpSelected': {
          if (tabRef.current !== 'NEW') return;
          const ticket = list[selectedIdxRef.current];
          if (!ticket) return;
          const itemListIdx = selectedItemIdxRef.current;
          if (itemListIdx === null) {
            void bumpTicketRef.current(ticket);
            return;
          }
          void bumpItemRef.current(ticket, itemListIdx);
          return;
        }
        case 'recall':
          if (tabRef.current !== 'NEW') return;
          void (async () => {
            const res = await window.api.kds
              .recall({ station: stationRef.current })
              .catch(() => ({ ok: false, ticketId: null }));
            if (!res?.ok) return;
            applyTab('NEW');
            setSelectedIdx(0);
            selectedIdxRef.current = 0;
            syncItemSelection(null);
            const rows = (await window.api.kds
              .listTickets({
                station: stationRef.current,
                status: 'NEW',
                limit: 120,
              })
              .catch(() => [])) as KdsTicket[];
            setTickets(Array.isArray(rows) ? rows : []);
          })();
          return;
        case 'recallSelected': {
          if (tabRef.current !== 'DONE') return;
          const ticket = list[selectedIdxRef.current];
          if (!ticket) return;
          const itemListIdx = selectedItemIdxRef.current;
          const payload: {
            station: typeof stationRef.current;
            ticketId: number;
            itemIdx?: number;
          } = {
            station: stationRef.current,
            ticketId: ticket.ticketId,
          };
          if (itemListIdx != null) {
            const it = ticket.items[itemListIdx];
            const itemIdx = Number(it?._idx ?? -1);
            if (Number.isFinite(itemIdx) && itemIdx >= 0) {
              payload.itemIdx = itemIdx;
            }
          }
          void (async () => {
            const res = await window.api.kds.recall(payload).catch(() => ({
              ok: false,
              ticketId: null,
            }));
            if (!res?.ok) return;
            applyTab('NEW');
            setSelectedIdx(0);
            selectedIdxRef.current = 0;
            syncItemSelection(null);
            const rows = (await window.api.kds
              .listTickets({
                station: stationRef.current,
                status: 'NEW',
                limit: 120,
              })
              .catch(() => [])) as KdsTicket[];
            setTickets(Array.isArray(rows) ? rows : []);
          })();
          return;
        }
        case 'clearDone': {
          if (tabRef.current !== 'DONE') return;
          void (async () => {
            try {
              const res = await window.api.kds.clearDone({
                station: stationRef.current,
              });
              if (!res?.ok) {
                setErr(
                  'Could not clear Done tickets. Restart the POS app on the host PC, then try again.',
                );
                return;
              }
              setErr(null);
              const rows = (await window.api.kds
                .listTickets({
                  station: stationRef.current,
                  status: 'DONE',
                  limit: 80,
                })
                .catch(() => [])) as KdsTicket[];
              setTickets(Array.isArray(rows) ? rows : []);
              setSelectedIdx(0);
              selectedIdxRef.current = 0;
              syncItemSelection(null);
            } catch (e: any) {
              setErr(
                e?.message ||
                  'Could not clear Done tickets. Restart the POS app on the host PC, then try again.',
              );
            }
          })();
          return;
        }
      }
    };

    const kdsApp =
      typeof window !== 'undefined'
        ? ((window as any).kdsApp as
            | {
                onBumpBarAction?: (
                  cb: (action: KdsBumpBarAction) => void,
                ) => () => void;
              }
            | undefined)
        : undefined;

    if (kdsApp?.onBumpBarAction) {
      return kdsApp.onBumpBarAction(dispatchBumpBarAction);
    }

    const onKey = (e: KeyboardEvent) => {
      const action = kdsBumpBarActionFromEvent(e);
      if (!action) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        target !== pageRef.current &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      dispatchBumpBarAction(action);
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div
      ref={pageRef}
      data-kds-page
      tabIndex={-1}
      className="h-full min-h-screen bg-gray-950 text-gray-100 p-4 flex flex-col outline-none"
    >
      <div className="flex items-center justify-between gap-4 mb-3">
        <div>
          <div className="text-xl font-semibold">{title}</div>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex overflow-hidden rounded-lg border border-gray-800 select-none"
            aria-label="KDS tab"
          >
            <div
              role="tab"
              aria-selected={tab === 'NEW'}
              className={`px-3 py-2 text-sm font-semibold ${
                tab === 'NEW'
                  ? 'bg-emerald-700 text-white'
                  : 'bg-gray-900 text-gray-200'
              }`}
            >
              NEW
            </div>
            <div
              role="tab"
              aria-selected={tab === 'DONE'}
              className={`px-3 py-2 text-sm font-medium ${
                tab === 'DONE'
                  ? 'bg-gray-800 text-white'
                  : 'bg-gray-900 text-gray-200'
              }`}
            >
              Done
            </div>
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
        <div className="flex flex-1 items-center justify-center min-h-0 py-8">
          <img
            src={logo512}
            alt="Ullishtja Agri Turizëm"
            className="max-h-[45vh] max-w-[min(420px,75vw)] w-auto object-contain"
          />
        </div>
      ) : (
        <div
          ref={ticketListRef}
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 overflow-y-auto flex-1 min-h-0 content-start"
        >
          {tickets.map((t, ticketIdx) => {
            const timeLabel =
              tab === 'NEW'
                ? fmtAgo(t.firedAt)
                : t.bumpedAt
                  ? fmtAgo(t.bumpedAt)
                  : '';
            const subline = [t.waiterName, timeLabel]
              .filter(Boolean)
              .join(' · ');

            return (
              <div
                key={`${station}-${tab}-${t.ticketId}`}
                data-kds-ticket-idx={ticketIdx}
                className={`relative bg-gray-900 border rounded p-3 transition-shadow ${
                  ticketIdx === selectedIdx
                    ? 'border-emerald-500 ring-2 ring-emerald-500/60'
                    : 'border-gray-800'
                }`}
              >
                {tab === 'NEW' && ticketIdx < 5 ? (
                  <div
                    className="absolute top-2 right-2 text-[10px] font-semibold opacity-40 tabular-nums"
                    aria-hidden
                  >
                    {ticketIdx + 2}
                  </div>
                ) : null}
                <div className="mb-2">
                  <div className="text-2xl font-bold">
                    {t.area} {t.tableLabel}
                  </div>
                  {subline ? (
                    <div className="text-sm opacity-80 mt-0.5">{subline}</div>
                  ) : null}
                </div>

                {t.note && (
                  <div className="mb-2 text-sm bg-gray-950 border border-gray-800 rounded p-2">
                    {t.note}
                  </div>
                )}

                <div className="space-y-1">
                  {t.items.map((it, idx) => {
                    const struck = Boolean(
                      it.voided || it.bumped || tab === 'DONE',
                    );
                    const itemSelected =
                      ticketIdx === selectedIdx &&
                      selectedItemIdx === idx &&
                      !it.voided;

                    return (
                      <div
                        key={idx}
                        data-kds-item-idx={idx}
                        className={`flex items-start justify-between gap-2 text-sm select-none rounded px-1 -mx-1 ${
                          struck ? 'opacity-50' : ''
                        } ${
                          itemSelected
                            ? 'bg-emerald-900/40 ring-1 ring-emerald-500/70'
                            : ''
                        }`}
                      >
                        <div
                          className={`font-medium ${struck ? 'line-through decoration-2' : ''}`}
                        >
                          {it.name}
                          {it.note ? (
                            <span className="opacity-70"> · {it.note}</span>
                          ) : null}
                        </div>
                        <div
                          className={`opacity-80 ${struck ? 'line-through decoration-2' : ''}`}
                        >
                          {Number(it.qty || 1)}x
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
