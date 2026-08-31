import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import { useOrderContext } from '@shared/stores/orderContext';
import { useNavigate } from 'react-router-dom';
import { useTableStatus } from '../../stores/tableStatus';
import { useTicketStore } from '../../stores/ticket';
import { formatMoneyCompact } from '../../utils/format';
import { PageSpinner } from '../../components/PageSpinner';
import { pickConfiguredArea, saneTableAreas } from '@shared/tableAreas';
import FloorCanvas from '../components/FloorCanvas';
import { sanitizeMergeGroups, type TableMergeGroup } from '@shared/tableMerge';

type ViewMode = 'occupied' | 'covers' | 'revenue' | 'time';

const RED = 'bg-rose-700';
const ORANGE = 'bg-amber-700';

function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0)
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function toInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] || '';
  const second = parts[1]?.[0] || '';
  return (first + second).toUpperCase();
}

export default function TablesPage() {
  const { t } = useTranslation();
  const [area, setArea] = useState<string>('');
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const [areasReady, setAreasReady] = useState(false);
  const { user } = useSessionStore();
  const [viewMode, setViewMode] = useState<ViewMode>('occupied');
  const [currency, setCurrency] = useState<string>('EUR');
  const { setSelectedTable, pendingAction, setPendingAction } =
    useOrderContext();
  const navigate = useNavigate();

  const openMap = useTableStatus((s) => s.openMap);
  const setAll = useTableStatus((s) => s.setAll);
  const setOpen = useTableStatus((s) => s.setOpen);

  const openMapKey = useMemo(() => {
    const keys = Object.keys(openMap)
      .filter((k) => openMap[k])
      .sort();
    return keys.join(',');
  }, [openMap]);

  const isOpenFn = useCallback(
    (a: string, label: string) => Boolean(openMap[`${a}:${label}`]),
    [openMap],
  );

  const [openLoaded, setOpenLoaded] = useState(false);
  const [openLoadError, setOpenLoadError] = useState<string | null>(null);
  const [mergeGroups, setMergeGroups] = useState<TableMergeGroup[]>([]);

  useEffect(() => {
    (window as any).__tableStatusStore__ = { setOpen };
    return () => {
      (window as any).__tableStatusStore__ = null;
    };
  }, [setOpen]);

  const reloadMerges = useCallback(async () => {
    if (!area) {
      setMergeGroups([]);
      return;
    }
    const groups = await window.api.layout.getMerges(area).catch(() => []);
    setMergeGroups(sanitizeMergeGroups(groups));
  }, [area]);

  useEffect(() => {
    void reloadMerges();
  }, [reloadMerges]);

  useEffect(() => {
    const onMerges = (ev: any) => {
      const detail = (ev?.detail || {}) as { area?: string };
      if (detail.area && area && String(detail.area) !== String(area)) return;
      void reloadMerges();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reloadMerges();
    };
    window.addEventListener('pos:tableMergesChanged', onMerges);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.removeEventListener('pos:tableMergesChanged', onMerges);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [area, reloadMerges]);

  useEffect(() => {
    const onChanged = (ev: any) => {
      try {
        const {
          area: a,
          label: l,
          open: o,
        } = (ev?.detail || {}) as {
          area?: string;
          label?: string;
          open?: boolean;
        };
        if (a && l && typeof o === 'boolean') setOpen(a, l, o);
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:tablesChanged', onChanged);
    return () => window.removeEventListener('pos:tablesChanged', onChanged);
  }, [setOpen]);

  const { hydrate, clear } = useTicketStore();

  const [userMap, setUserMap] = useState<Record<number, string>>({});
  const [initialsByTable, setInitialsByTable] = useState<
    Record<string, string>
  >({});
  const [ownerByTable, setOwnerByTable] = useState<Record<string, number>>({});
  const [metricsByTable, setMetricsByTable] = useState<
    Record<string, { covers: number | null; total: number }>
  >({});
  const [openedAtByTable, setOpenedAtByTable] = useState<
    Record<string, string>
  >({});
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [users, s] = await Promise.all([
          window.api.auth.listUsers(),
          window.api.settings.get(),
        ]);
        if (cancelled) return;
        const map: Record<number, string> = {};
        for (const u of users) map[u.id] = u.displayName;
        setUserMap(map);
        setCurrency(
          String((s as any)?.currency || 'EUR')
            .trim()
            .toUpperCase() || 'EUR',
        );
        const nextAreas = saneTableAreas(s?.tableAreas);
        setAreas(nextAreas);
        setArea((current) => pickConfiguredArea(current, nextAreas));
      } catch {
        // ignore — empty-area UI stays until settings succeed
      } finally {
        if (!cancelled) setAreasReady(true);
      }
    };
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  const pollGenRef = useRef(0);
  useEffect(() => {
    const gen = ++pollGenRef.current;
    setOpenLoaded(false);
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const fetchOnce = async () => {
      try {
        if (isHidden()) {
          if (!cancelled && gen === pollGenRef.current) setOpenLoaded(true);
          return;
        }
        const open = await window.api.tables.listOpen();
        if (cancelled || gen !== pollGenRef.current) return;
        if (Array.isArray(open)) setAll(open);
        setOpenLoaded(true);
        setOpenLoadError(null);
      } catch {
        if (!cancelled && gen === pollGenRef.current) {
          setOpenLoaded(true);
          setOpenLoadError(
            'Loading occupied tables… (slow/offline network). Retrying…',
          );
        }
      }
    };

    const poll = async () => {
      try {
        if (isHidden()) return;
        const open = await window.api.tables.listOpen();
        if (cancelled || gen !== pollGenRef.current) return;
        if (Array.isArray(open)) setAll(open);
      } catch {
        // ignore poll errors
      } finally {
        if (!cancelled && gen === pollGenRef.current) {
          timer = setTimeout(poll, isHidden() ? 12000 : 4000);
        }
      }
    };

    fetchOnce().then(() => {
      if (!cancelled && gen === pollGenRef.current) {
        timer = setTimeout(poll, 4000);
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [setAll]);

  const openLabelsInArea = useMemo(() => {
    if (!area) return [] as string[];
    const prefix = `${area}:`;
    return Object.keys(openMap)
      .filter((k) => openMap[k] && k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }, [area, openMapKey, openMap]);

  useEffect(() => {
    if (!openLoaded || !area) return;
    let cancelled = false;
    const labels = openLabelsInArea;

    (async () => {
      const badgeUpdates: [string, string][] = [];
      const ownerUpdates: [string, number][] = [];
      await Promise.all(
        labels.map(async (label) => {
          const k = `${area}:${label}`;
          try {
            const data = await window.api.tickets.getLatestForTable(
              area,
              label,
            );
            if (cancelled) return;
            if (data?.userId) ownerUpdates.push([k, data.userId]);
            if (data?.userId && userMap[data.userId])
              badgeUpdates.push([k, toInitials(userMap[data.userId])]);
          } catch {
            // ignore
          }
        }),
      );
      if (cancelled) return;
      setInitialsByTable((prev) => {
        const next: Record<string, string> = {};
        for (const [key, val] of Object.entries(prev)) {
          if (!key.startsWith(`${area}:`)) next[key] = val;
        }
        for (const [k, v] of badgeUpdates) next[k] = v;
        return next;
      });
      setOwnerByTable((prev) => {
        const next: Record<string, number> = {};
        for (const [key, val] of Object.entries(prev)) {
          if (!key.startsWith(`${area}:`)) next[key] = val as number;
        }
        for (const [k, v] of ownerUpdates) next[k] = v;
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [openLoaded, area, openLabelsInArea, userMap]);

  useEffect(() => {
    const onTicketsChanged = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as {
          area?: string;
          tableLabel?: string;
          userId?: number | null;
        };
        const a = detail.area;
        const label = detail.tableLabel;
        if (!a || !label || a !== area) return;
        const k = `${a}:${label}`;
        const uid = Number(detail.userId);
        if (Number.isFinite(uid) && uid > 0) {
          setOwnerByTable((prev) => ({ ...prev, [k]: uid }));
          const name = userMap[uid];
          if (name)
            setInitialsByTable((prev) => ({ ...prev, [k]: toInitials(name) }));
        }
        (async () => {
          try {
            const data = await window.api.tickets.getLatestForTable(a, label);
            const lid = Number(data?.userId || 0);
            if (!lid) return;
            setOwnerByTable((prev) => ({ ...prev, [k]: lid }));
            const nm = userMap[lid];
            if (nm)
              setInitialsByTable((prev) => ({
                ...prev,
                [k]: toInitials(nm),
              }));
          } catch {
            // ignore
          }
        })();
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:ticketsChanged', onTicketsChanged);
    return () =>
      window.removeEventListener('pos:ticketsChanged', onTicketsChanged);
  }, [area, userMap]);

  useEffect(() => {
    if (!openLoaded || !area) return;
    if (viewMode !== 'covers' && viewMode !== 'revenue') return;
    let cancelled = false;
    const labels = openLabelsInArea;

    const load = async () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return;
      if (!labels.length) {
        setMetricsByTable((prev) => {
          const next: Record<string, { covers: number | null; total: number }> =
            {};
          for (const [k, v] of Object.entries(prev))
            if (!k.startsWith(`${area}:`)) next[k] = v;
          return next;
        });
        return;
      }

      const updates: Array<[string, { covers: number | null; total: number }]> =
        [];
      const queue = [...labels];
      const concurrency = Math.min(6, queue.length);
      const workers = Array.from({ length: concurrency }).map(async () => {
        while (queue.length && !cancelled) {
          const label = queue.shift()!;
          try {
            const [last, covers] = await Promise.all([
              (window as any).api.tickets
                .getLatestForTable(area, label)
                .catch(() => null),
              (window as any).api.covers.getLast(area, label).catch(() => null),
            ]);
            const items = Array.isArray(last?.items) ? last.items : [];
            const total = items
              .filter((it: any) => !it?.voided)
              .reduce(
                (s: number, it: any) =>
                  s + Number(it?.unitPrice || 0) * Number(it?.qty || 1),
                0,
              );
            const cov = covers ?? last?.covers ?? null;
            updates.push([
              `${area}:${label}`,
              { covers: cov, total: Number(total || 0) },
            ]);
          } catch {
            // ignore
          }
        }
      });
      await Promise.all(workers);
      if (cancelled) return;

      setMetricsByTable((prev) => {
        const next: Record<string, { covers: number | null; total: number }> = {
          ...prev,
        };
        for (const [k, v] of updates) next[k] = v;
        for (const k of Object.keys(next)) {
          if (!k.startsWith(`${area}:`)) continue;
          const l = k.split(':').slice(1).join(':');
          if (!labels.includes(l)) delete next[k];
        }
        return next;
      });
    };

    void load();
    const t = window.setInterval(load, 12000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [openLoaded, area, viewMode, openLabelsInArea]);

  useEffect(() => {
    if (!openLoaded || !area) return;
    if (viewMode !== 'time') return;
    let cancelled = false;
    const labels = openLabelsInArea;

    const load = async () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return;
      if (!labels.length) {
        setOpenedAtByTable((prev) => {
          const next: Record<string, string> = {};
          for (const [k, v] of Object.entries(prev))
            if (!k.startsWith(`${area}:`)) next[k] = v;
          return next;
        });
        return;
      }

      const updates: Array<[string, string]> = [];
      const queue = [...labels];
      const concurrency = Math.min(6, queue.length);
      const workers = Array.from({ length: concurrency }).map(async () => {
        while (queue.length && !cancelled) {
          const label = queue.shift()!;
          try {
            const tip = await (window as any).api.tickets
              .getTableTooltip(area, label)
              .catch(() => null);
            const iso = String((tip as any)?.firstAt || '');
            if (iso) updates.push([`${area}:${label}`, iso]);
          } catch {
            // ignore
          }
        }
      });
      await Promise.all(workers);
      if (cancelled) return;

      setOpenedAtByTable((prev) => {
        const next: Record<string, string> = { ...prev };
        for (const [k, v] of updates) next[k] = v;
        for (const k of Object.keys(next)) {
          if (!k.startsWith(`${area}:`)) continue;
          const l = k.split(':').slice(1).join(':');
          if (!labels.includes(l)) delete next[k];
        }
        return next;
      });
    };

    void load();
    const t = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [openLoaded, area, viewMode, openLabelsInArea]);

  useEffect(() => {
    if (viewMode !== 'time') return;
    if (!openLabelsInArea.length) return;
    const t = window.setInterval(() => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return;
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(t);
  }, [viewMode, openLabelsInArea.length]);

  const formatMoney = useCallback(
    (n: number) => formatMoneyCompact(currency, n),
    [currency],
  );

  const colorByLabel = useMemo(() => {
    const out: Record<string, string> = {};
    const uid = user?.id;
    const singleWaiter = Object.keys(userMap).length <= 1;
    for (const label of openLabelsInArea) {
      const ownerId = ownerByTable[`${area}:${label}`];
      if (
        singleWaiter ||
        ownerId == null ||
        (uid != null && Number(ownerId) === Number(uid))
      ) {
        out[label] = RED;
      } else {
        out[label] = ORANGE;
      }
    }
    return out;
  }, [openLabelsInArea, ownerByTable, area, user?.id, userMap]);

  const badgeByLabel = useMemo(() => {
    const out: Record<string, string | null | undefined> = {};
    for (const label of openLabelsInArea) {
      const k = `${area}:${label}`;
      if (viewMode === 'covers') {
        const m = metricsByTable[k];
        out[label] = m ? String(m.covers ?? '—') : '…';
      } else if (viewMode === 'revenue') {
        const m = metricsByTable[k];
        out[label] = m ? formatMoney(m.total) : '…';
      } else if (viewMode === 'time') {
        const iso = openedAtByTable[k];
        const ms = iso ? new Date(iso).getTime() : NaN;
        out[label] = Number.isFinite(ms) ? formatElapsed(nowMs - ms) : '…';
      } else {
        out[label] = initialsByTable[k];
      }
    }
    return out;
  }, [
    openLabelsInArea,
    area,
    viewMode,
    metricsByTable,
    openedAtByTable,
    initialsByTable,
    nowMs,
    formatMoney,
  ]);

  const handleTableClick = useCallback(
    (label: string, members?: string[]) => {
      const labels = (members?.length ? members : [label]).filter(Boolean);
      const openLabel =
        labels.find((l) => isOpenFn(area, l)) || labels[0] || label;
      setSelectedTable({ id: 0, label: openLabel, area });
      const action = pendingAction;
      if (action) setPendingAction(null);
      if (isOpenFn(area, openLabel)) {
        void (async () => {
          const data = await window.api.tickets.getLatestForTable(
            area,
            openLabel,
          );
          if (data)
            hydrate({ items: data.items as any, note: data.note || '' });
          else clear();
          navigate('/app/order');
        })();
        return;
      }
      clear();
      navigate('/app/order');
    },
    [
      area,
      pendingAction,
      setPendingAction,
      setSelectedTable,
      isOpenFn,
      hydrate,
      clear,
      navigate,
    ],
  );

  if (!openLoaded || !areasReady) {
    return <PageSpinner message={openLoadError || t('tables.loading')} />;
  }

  return (
    <div className="h-full min-h-0 relative overflow-hidden bg-black">
      <div className="absolute inset-0 flex flex-col">
        {areasReady && !area ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400 px-6 text-center">
            {t('tables.noAreas')}
          </div>
        ) : null}
        {user && area ? (
          <FloorCanvas
            userId={user.id}
            area={area}
            editable={false}
            fillAvailableHeight
            flush
            fitPadding={72}
            emptyMessage={t('tables.noLayout')}
            colorByLabel={colorByLabel}
            badgeByLabel={badgeByLabel}
            mergeGroups={mergeGroups}
            onTableClick={handleTableClick}
          />
        ) : null}
      </div>

      <div className="absolute top-0 left-0 right-0 z-10 flex items-start justify-end gap-3 px-3 sm:px-4 pt-3 pointer-events-none">
        <div className="pointer-events-auto flex gap-2 overflow-x-auto no-scrollbar max-w-full">
          {areas.map((a) => (
            <button
              key={a.name}
              className={`pos-floor-chip ${
                area === a.name ? 'pos-floor-chip--active' : ''
              }`}
              onClick={() => setArea(a.name)}
            >
              {a.name}
            </button>
          ))}
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 z-10 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pointer-events-none">
        <div className="pointer-events-auto pos-floor-dock">
          <ModeButton
            active={viewMode === 'occupied'}
            onClick={() => setViewMode('occupied')}
            label={t('tables.modeOccupied')}
          >
            <IconUsers />
          </ModeButton>
          <ModeButton
            active={viewMode === 'covers'}
            onClick={() => setViewMode('covers')}
            label={t('tables.modeCovers')}
          >
            <IconCovers />
          </ModeButton>
          <ModeButton
            active={viewMode === 'revenue'}
            onClick={() => setViewMode('revenue')}
            label={t('tables.modeRevenue')}
          >
            <IconMoney />
          </ModeButton>
          <ModeButton
            active={viewMode === 'time'}
            onClick={() => setViewMode('time')}
            label={t('tables.modeTime')}
          >
            <IconClock />
          </ModeButton>
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: any;
}) {
  return (
    <button
      className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 rounded-md transition-colors duration-100 min-h-0 ${
        active
          ? 'bg-gray-50 text-gray-900'
          : 'text-gray-300 hover:bg-white/8 hover:text-gray-50'
      }`}
      onClick={onClick}
      title={label}
      type="button"
      aria-pressed={active}
    >
      <span className={active ? 'opacity-100' : 'opacity-80'}>{children}</span>
      <span className="text-xs sm:text-sm">{label}</span>
    </button>
  );
}

function IconUsers() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM4 20a7 7 0 0 1 16 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCovers() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M12 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM2 22a7 7 0 0 1 14 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M20 8a3 3 0 1 0-6 0 3 3 0 0 0 6 0ZM13.5 22a6 6 0 0 1 8.5-5.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMoney() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M7 7h10a4 4 0 0 1 0 8H9a3 3 0 0 0 0 6h8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 3v18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconClock() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M12 22a10 10 0 1 0-10-10 10 10 0 0 0 10 10Z"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M12 6v6l4 2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
