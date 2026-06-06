import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logo512 from '../../../../public/logo512.png';
import {
  ALL_KDS_STATIONS,
  kdsStationLabel,
  type KdsStation,
} from '@shared/kdsStations';
import {
  loadKdsDisplayStation,
  saveKdsDisplayStation,
  loadKdsTheme,
  saveKdsTheme,
  type KdsTheme,
} from '../../utils/kdsDisplayConfig';
import {
  KDS_BUMP_BAR_PROGRAMMING,
  kdsBumpBarActionFromEvent,
  type KdsBumpBarAction,
} from '../../utils/kdsBumpBar';
import {
  KDS_TIMER_LATE_MINUTES,
  KDS_TIMER_WARNING_MINUTES,
  kdsTimerUrgencyCardAccent,
  kdsTimerUrgencyFromIso,
  kdsTimerUrgencyTextClass,
} from '@shared/kdsTimerUrgency';

type Station = KdsStation;
type Tab = 'NEW' | 'DONE' | 'SETTINGS';

type KdsTicketDetail = import('@shared/ipc').KdsTicketDetailDTO;

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

function fmtAgo(iso: string, atMs: number = nowMs()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((atMs - t) / 1000));
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

const TICKET_GAP_PX = 12;
const COLUMN_GAP_PX = 12;

function columnWidthForContainer(containerWidth: number): number {
  return Math.min(380, Math.max(280, containerWidth * 0.28));
}

function maxColumnsForWidth(containerWidth: number): number {
  const colW = columnWidthForContainer(containerWidth);
  return Math.max(
    1,
    Math.floor((containerWidth + COLUMN_GAP_PX) / (colW + COLUMN_GAP_PX)),
  );
}

function estimateTicketHeight(t: KdsTicket): number {
  let h = 76;
  if (t.note) h += 52;
  h += Math.max(1, t.items.length) * 28;
  return h;
}

/** Pack tickets into pages: columns fill top→bottom, then next column, then next page. */
function paginateTickets(
  tickets: KdsTicket[],
  containerWidth: number,
  containerHeight: number,
): number[][] {
  if (tickets.length === 0) return [];
  if (containerWidth <= 0 || containerHeight <= 0)
    return [tickets.map((_, i) => i)];

  const maxCols = maxColumnsForWidth(containerWidth);
  const pageHeight = containerHeight;

  const pages: number[][] = [[]];
  let activeCol = 0;
  const columnHeights = new Array(maxCols).fill(0);

  for (let i = 0; i < tickets.length; i++) {
    const h = estimateTicketHeight(tickets[i]);
    let placed = false;

    while (!placed) {
      const gap = columnHeights[activeCol] > 0 ? TICKET_GAP_PX : 0;
      if (columnHeights[activeCol] + gap + h <= pageHeight) {
        pages[pages.length - 1].push(i);
        columnHeights[activeCol] += gap + h;
        placed = true;
      } else if (activeCol < maxCols - 1) {
        activeCol += 1;
      } else {
        pages.push([]);
        activeCol = 0;
        columnHeights.fill(0);
      }
    }
  }

  return pages.filter((p) => p.length > 0);
}

function countTicketsOnPages(pages: number[][], fromPage: number): number {
  let n = 0;
  for (let p = fromPage; p < pages.length; p++) n += pages[p].length;
  return n;
}

export default function KdsPage() {
  const navigate = useNavigate();
  const initialStation = loadKdsDisplayStation();
  const [station, setStationState] = useState<Station>(initialStation);
  const [theme, setThemeState] = useState<KdsTheme>(() => loadKdsTheme());
  const [tab, setTab] = useState<Tab>('NEW');
  const [tickets, setTickets] = useState<KdsTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const bumping = useRef<Set<number>>(new Set());
  const errRef = useRef<string | null>(null);
  const ticketsRef = useRef<KdsTicket[]>([]);
  const tabRef = useRef<Tab>('NEW');
  const stationRef = useRef<Station>(initialStation);
  const selectedIdxRef = useRef(0);
  const selectedItemIdxRef = useRef<number | null>(null);
  const ticketListRef = useRef<HTMLDivElement | null>(null);
  const ticketBoardRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [selectedItemIdx, setSelectedItemIdx] = useState<number | null>(null);
  const [listPage, setListPage] = useState(0);
  const listPageRef = useRef(0);
  const ticketPagesRef = useRef<number[][]>([]);
  const prevSelectedIdxForPageRef = useRef(0);
  const [boardSize, setBoardSize] = useState({ width: 0, height: 0 });
  const [ticketSummary, setTicketSummary] = useState<KdsTicketDetail | null>(
    null,
  );
  const [ticketSummaryLoading, setTicketSummaryLoading] = useState(false);
  const ticketSummaryRef = useRef<KdsTicketDetail | null>(null);
  const ticketSummaryLoadingRef = useRef(false);
  const [clockMs, setClockMs] = useState(() => Date.now());

  const setStation = useCallback((next: Station) => {
    setStationState(next);
    stationRef.current = next;
    saveKdsDisplayStation(next);
  }, []);
  const setTheme = useCallback((next: KdsTheme) => {
    setThemeState(next);
    saveKdsTheme(next);
  }, []);
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
    ticketSummaryRef.current = ticketSummary;
  }, [ticketSummary]);
  useEffect(() => {
    ticketSummaryLoadingRef.current = ticketSummaryLoading;
  }, [ticketSummaryLoading]);
  useEffect(() => {
    setSelectedIdx(0);
    selectedIdxRef.current = 0;
    setSelectedItemIdx(null);
    selectedItemIdxRef.current = null;
    setListPage(0);
    listPageRef.current = 0;
    prevSelectedIdxForPageRef.current = 0;
  }, [tab, station]);

  useEffect(() => {
    listPageRef.current = listPage;
  }, [listPage]);

  useEffect(() => {
    if (tab !== 'NEW' || tickets.length === 0) return;
    const id = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [tab, tickets.length]);

  useEffect(() => {
    const el = ticketBoardRef.current;
    if (!el) return;
    const update = () => {
      setBoardSize({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [tab, loading]);

  const ticketPages = useMemo(
    () => paginateTickets(tickets, boardSize.width, boardSize.height),
    [tickets, boardSize.width, boardSize.height],
  );

  useEffect(() => {
    ticketPagesRef.current = ticketPages;
  }, [ticketPages]);

  useEffect(() => {
    setListPage((p) => Math.min(p, Math.max(0, ticketPages.length - 1)));
  }, [ticketPages.length]);

  useEffect(() => {
    if (ticketPages.length === 0) return;
    if (selectedIdx === prevSelectedIdxForPageRef.current) return;
    prevSelectedIdxForPageRef.current = selectedIdx;
    const pageForSelected = ticketPages.findIndex((page) =>
      page.includes(selectedIdx),
    );
    if (pageForSelected >= 0) {
      setListPage(pageForSelected);
    }
  }, [selectedIdx, ticketPages]);

  const visibleTicketIndices = ticketPages[listPage] ?? [];
  const remainingTicketCount = countTicketsOnPages(ticketPages, listPage + 1);
  const previousTicketCount = ticketPages
    .slice(0, listPage)
    .reduce((sum, p) => sum + p.length, 0);
  const totalPages = ticketPages.length;
  const colWidth =
    boardSize.width > 0 ? columnWidthForContainer(boardSize.width) : 320;

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

  const title = useMemo(() => {
    return `${kdsStationLabel(station)} Display`;
  }, [station]);

  useEffect(() => {
    if (tab === 'SETTINGS') {
      setLoading(false);
      return;
    }

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
          if (
            ticketSummaryRef.current != null ||
            ticketSummaryLoadingRef.current
          ) {
            setTicketSummary(null);
            setTicketSummaryLoading(false);
            return;
          }
          return;
        case 'showTicketSummary': {
          if (tabRef.current === 'SETTINGS') return;
          if (
            ticketSummaryRef.current != null ||
            ticketSummaryLoadingRef.current
          ) {
            setTicketSummary(null);
            setTicketSummaryLoading(false);
            return;
          }
          const ticket = list[selectedIdxRef.current];
          if (!ticket) return;
          void (async () => {
            setTicketSummaryLoading(true);
            try {
              const detail = (await window.api.kds.getTicketDetail({
                ticketId: ticket.ticketId,
              })) as KdsTicketDetail | null;
              if (detail) setTicketSummary(detail);
              else
                setErr(
                  'Could not load full ticket. Try again or check POS connection.',
                );
            } catch (e: any) {
              setErr(
                e?.message ||
                  'Could not load full ticket. Try again or check POS connection.',
              );
            } finally {
              setTicketSummaryLoading(false);
            }
          })();
          return;
        }
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
        case 'showSettings':
          applyTab('SETTINGS');
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
          if (listPageRef.current > 0) setListPage((p) => Math.max(0, p - 1));
          return;
        case 'scrollDown':
          if (listPageRef.current < ticketPagesRef.current.length - 1) {
            setListPage((p) =>
              Math.min(ticketPagesRef.current.length - 1, p + 1),
            );
          }
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

  const isStandaloneKds =
    typeof window !== 'undefined' && Boolean((window as any).__KDS_APP__);
  const posHost = (window as any).__POS_HOST__ as
    | { host?: string; httpPort?: number }
    | undefined;

  return (
    <div
      ref={pageRef}
      data-kds-page
      data-theme={theme}
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
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'NEW'}
              onClick={() => setTab('NEW')}
              className={`px-3 py-2 text-sm font-semibold ${
                tab === 'NEW'
                  ? 'bg-emerald-700 text-white'
                  : 'bg-gray-900 text-gray-200 hover:bg-gray-800'
              }`}
            >
              NEW
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'DONE'}
              onClick={() => setTab('DONE')}
              className={`px-3 py-2 text-sm font-medium ${
                tab === 'DONE'
                  ? 'bg-gray-800 text-white'
                  : 'bg-gray-900 text-gray-200 hover:bg-gray-800'
              }`}
            >
              Done
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'SETTINGS'}
              onClick={() => setTab('SETTINGS')}
              className={`px-3 py-2 text-sm font-medium ${
                tab === 'SETTINGS'
                  ? 'bg-indigo-700 text-white'
                  : 'bg-gray-900 text-gray-200 hover:bg-gray-800'
              }`}
            >
              Settings
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

      {tab === 'SETTINGS' ? (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-5 max-w-3xl">
          <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <div className="text-sm font-semibold">Display station</div>
            <div className="text-xs opacity-70">
              Choose which prep station this screen shows. Your choice is saved
              for next time.
            </div>
            <div className="flex flex-wrap gap-2">
              {ALL_KDS_STATIONS.map((st) => {
                const label = kdsStationLabel(st);
                const active = station === st;
                return (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStation(st)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium ${
                      active
                        ? 'bg-emerald-700 text-white'
                        : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <div className="text-sm font-semibold">Theme</div>
            <div className="text-xs opacity-70">
              Switch the kitchen display between dark and light. Your choice is
              saved and kept after restarts and updates.
            </div>
            <div className="flex flex-wrap gap-2">
              {(['dark', 'light'] as const).map((opt) => {
                const active = theme === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setTheme(opt)}
                    aria-pressed={active}
                    className={`px-4 py-2 rounded-lg text-sm font-medium capitalize ${
                      active
                        ? 'bg-emerald-700 text-white'
                        : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                    }`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </section>

          {isStandaloneKds ? (
            <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
              <div className="text-sm font-semibold">POS connection</div>
              {posHost?.host ? (
                <div className="text-sm font-mono opacity-80">
                  {posHost.host}
                  {posHost.httpPort ? `:${posHost.httpPort}` : ''}
                </div>
              ) : (
                <div className="text-sm opacity-70">Not connected yet.</div>
              )}
              <button
                type="button"
                onClick={() => navigate('/kds-setup')}
                className="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-sm font-medium"
              >
                Connect to POS
              </button>
            </section>
          ) : null}

          <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <div className="text-sm font-semibold">Timer colors (NEW)</div>
            <div className="text-xs opacity-70 space-y-1">
              <div>
                <span className="text-emerald-400 font-mono">Green</span> —
                under {KDS_TIMER_WARNING_MINUTES} min
              </div>
              <div>
                <span className="text-amber-400 font-mono">Amber</span> —{' '}
                {KDS_TIMER_WARNING_MINUTES}–{KDS_TIMER_LATE_MINUTES - 1} min
              </div>
              <div>
                <span className="text-rose-400 font-mono">Red</span> —{' '}
                {KDS_TIMER_LATE_MINUTES} min or more
              </div>
            </div>
          </section>

          <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <div className="text-sm font-semibold">Bump bar keys</div>
            <div className="text-xs opacity-70">
              Program each physical key to send the keystroke below. Press{' '}
              <span className="font-mono text-indigo-300">J</span> on the bump
              bar to open this Settings tab.
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
                    <tr
                      key={row.button}
                      className="border-b border-gray-900/80"
                    >
                      <td className="py-1.5 pr-3 font-medium">{row.button}</td>
                      <td className="py-1.5 pr-3 font-mono">{row.keystroke}</td>
                      <td className="py-1.5 opacity-80">{row.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : tickets.length === 0 && !loading ? (
        <div className="flex flex-1 items-center justify-center min-h-0 py-8">
          <img
            src={logo512}
            alt="Ullishtja Agri Turizëm"
            className="max-h-[45vh] max-w-[min(420px,75vw)] w-auto object-contain"
          />
        </div>
      ) : (
        <div
          ref={ticketBoardRef}
          className="relative flex-1 min-h-0 flex flex-col"
        >
          <div ref={ticketListRef} className="flex-1 min-h-0 overflow-hidden">
            <div className="flex h-full w-max min-w-full flex-col flex-wrap content-start items-start gap-3">
              {visibleTicketIndices.map((ticketIdx) => {
                const t = tickets[ticketIdx];
                if (!t) return null;
                const timeIso =
                  tab === 'NEW' ? t.firedAt : t.bumpedAt ? t.bumpedAt : null;
                const timeLabel = timeIso ? fmtAgo(timeIso, clockMs) : '';
                const timerUrgency =
                  tab === 'NEW' && t.firedAt
                    ? kdsTimerUrgencyFromIso(t.firedAt, clockMs)
                    : null;

                return (
                  <div
                    key={`${station}-${tab}-${t.ticketId}`}
                    data-kds-ticket-idx={ticketIdx}
                    className={`relative shrink-0 self-start bg-gray-900 border rounded p-3 transition-shadow ${
                      timerUrgency
                        ? kdsTimerUrgencyCardAccent(timerUrgency)
                        : ''
                    } ${
                      ticketIdx === selectedIdx
                        ? 'border-emerald-500 ring-2 ring-emerald-500/60'
                        : 'border-gray-800'
                    }`}
                    style={{ width: colWidth }}
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
                      <div className="text-3xl font-bold leading-tight">
                        {t.area} {t.tableLabel}
                      </div>
                      {t.waiterName || timeLabel ? (
                        <div className="text-base mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                          {t.waiterName ? (
                            <span className="opacity-80">{t.waiterName}</span>
                          ) : null}
                          {t.waiterName && timeLabel ? (
                            <span className="opacity-50" aria-hidden>
                              ·
                            </span>
                          ) : null}
                          {timeLabel ? (
                            <span
                              className={`font-mono tabular-nums font-semibold ${
                                timerUrgency
                                  ? kdsTimerUrgencyTextClass(timerUrgency)
                                  : 'opacity-70'
                              }`}
                              title={
                                tab === 'NEW' && timerUrgency
                                  ? `Fired ${timeLabel} ago`
                                  : undefined
                              }
                            >
                              {timeLabel}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    {t.note && (
                      <div className="mb-2 text-base bg-gray-950 border border-gray-800 rounded p-2">
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
                            className={`flex items-start justify-between gap-2 text-lg leading-snug select-none rounded px-1 -mx-1 ${
                              struck ? 'opacity-50' : ''
                            } ${
                              itemSelected
                                ? 'bg-emerald-900/40 ring-1 ring-emerald-500/70'
                                : ''
                            }`}
                          >
                            <div
                              className={`font-semibold ${struck ? 'line-through decoration-2' : ''}`}
                            >
                              {it.name}
                              {it.note ? (
                                <span className="opacity-70 text-base">
                                  {' '}
                                  · {it.note}
                                </span>
                              ) : null}
                            </div>
                            <div
                              className={`font-bold tabular-nums shrink-0 ${struck ? 'line-through decoration-2' : ''}`}
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
          </div>

          {totalPages > 1 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between px-1 pb-1">
              {listPage > 0 ? (
                <button
                  type="button"
                  aria-label={`Previous page, ${previousTicketCount} tickets`}
                  className="pointer-events-auto flex h-16 w-16 flex-col items-center justify-center rounded-full border-2 border-gray-600 bg-gray-900/95 text-white shadow-lg hover:bg-gray-800 active:scale-95"
                  onClick={() => setListPage((p) => Math.max(0, p - 1))}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="h-7 w-7"
                    aria-hidden
                  >
                    <path
                      d="M14 6l-6 6 6 6"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {previousTicketCount > 0 ? (
                    <span className="mt-0.5 text-xs font-bold tabular-nums leading-none">
                      {previousTicketCount}
                    </span>
                  ) : null}
                </button>
              ) : (
                <span />
              )}

              <div className="pointer-events-none mb-2 text-xs font-medium tabular-nums opacity-60">
                {listPage + 1} / {totalPages}
              </div>

              {remainingTicketCount > 0 ? (
                <button
                  type="button"
                  aria-label={`Next page, ${remainingTicketCount} tickets remaining`}
                  className="pointer-events-auto flex h-16 w-16 flex-col items-center justify-center rounded-full border-2 border-emerald-600 bg-emerald-900/95 text-white shadow-lg hover:bg-emerald-800 active:scale-95"
                  onClick={() =>
                    setListPage((p) => Math.min(totalPages - 1, p + 1))
                  }
                >
                  <span className="text-lg font-bold tabular-nums leading-none">
                    {remainingTicketCount}
                  </span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="mt-0.5 h-6 w-6"
                    aria-hidden
                  >
                    <path
                      d="M10 6l6 6-6 6"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : (
                <span />
              )}
            </div>
          ) : null}
        </div>
      )}

      {(ticketSummaryLoading || ticketSummary) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Full ticket summary"
          onClick={() => {
            setTicketSummary(null);
            setTicketSummaryLoading(false);
          }}
        >
          <div
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {ticketSummaryLoading && !ticketSummary ? (
              <div className="p-8 text-center text-lg opacity-80">
                Loading ticket…
              </div>
            ) : ticketSummary ? (
              <>
                <div className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/95 backdrop-blur px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-3xl font-bold">
                        {ticketSummary.area} {ticketSummary.tableLabel}
                      </div>
                      <div className="mt-1 text-sm flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        {ticketSummary.waiterName ? (
                          <span className="opacity-80">
                            {ticketSummary.waiterName}
                          </span>
                        ) : null}
                        {ticketSummary.firedAt ? (
                          <>
                            {ticketSummary.waiterName ? (
                              <span className="opacity-50" aria-hidden>
                                ·
                              </span>
                            ) : null}
                            {(() => {
                              const urgency = kdsTimerUrgencyFromIso(
                                ticketSummary.firedAt,
                                clockMs,
                              );
                              return (
                                <span
                                  className={`font-mono tabular-nums font-semibold ${
                                    urgency
                                      ? kdsTimerUrgencyTextClass(urgency)
                                      : 'opacity-70'
                                  }`}
                                >
                                  {fmtAgo(ticketSummary.firedAt, clockMs)}
                                </span>
                              );
                            })()}
                          </>
                        ) : null}
                        {ticketSummary.orderNo ? (
                          <>
                            {(ticketSummary.waiterName ||
                              ticketSummary.firedAt) && (
                              <span className="opacity-50" aria-hidden>
                                ·
                              </span>
                            )}
                            <span className="opacity-80">
                              #{ticketSummary.orderNo}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium hover:bg-gray-700"
                      onClick={() => setTicketSummary(null)}
                    >
                      Close (Esc)
                    </button>
                  </div>
                  {ticketSummary.note ? (
                    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950 p-3 text-sm">
                      {ticketSummary.note}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-5 p-5">
                  {ticketSummary.stations.map((section) => {
                    const isCurrentStation =
                      String(section.station).toUpperCase() === station;
                    return (
                      <section
                        key={String(section.station)}
                        className={`rounded-lg border p-4 ${
                          isCurrentStation
                            ? 'border-emerald-600/60 bg-emerald-950/20'
                            : 'border-gray-800 bg-gray-950/40'
                        }`}
                      >
                        <h3 className="mb-3 text-lg font-semibold">
                          {section.label}
                          {isCurrentStation ? (
                            <span className="ml-2 text-xs font-normal uppercase tracking-wide text-emerald-400">
                              This screen
                            </span>
                          ) : null}
                        </h3>
                        <div className="space-y-2">
                          {section.items.map((it, idx) => {
                            const struck = Boolean(it.voided || it.bumped);
                            return (
                              <div
                                key={`${section.station}-${it._idx ?? idx}`}
                                className={`flex items-start justify-between gap-3 text-base ${
                                  struck ? 'opacity-50 line-through' : ''
                                }`}
                              >
                                <div className="font-medium">
                                  {it.name}
                                  {it.note ? (
                                    <span className="font-normal opacity-70">
                                      {' '}
                                      · {it.note}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="shrink-0 opacity-80 tabular-nums">
                                  {Number(it.qty || 1)}×
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                  {ticketSummary.stations.length === 0 ? (
                    <div className="text-center opacity-70">
                      No items on this ticket.
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
