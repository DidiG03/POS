import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import { useOrderContext } from '@shared/stores/orderContext';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTableStatus } from '../../stores/tableStatus';
import { useTicketStore } from '../../stores/ticket';
import { tableKey } from '@shared/utils/tableKey';
import { formatMoneyCompact } from '../../utils/format';
import { PageSpinner } from '../../components/PageSpinner';
import { pickConfiguredArea, saneTableAreas } from '@shared/tableAreas';
import FloorCanvas from '../components/FloorCanvas';
import { sanitizeMergeGroups, type TableMergeGroup } from '@shared/tableMerge';
import type { FloorSnapshot, FloorTableSnapshot } from '@shared/ipc';
import { isSseHealthy, pollIntervalMs } from '../../utils/netQuality';
import {
  peekFloorSnapshot,
  peekSettings,
  prefetchHotReads,
  readFloorSnapshot,
} from '../../utils/posReadCache';
import { peekTableBill } from '../../utils/tableBill';
import { applyHostOpenTables } from '../../utils/openTablesSync';
import { bootTrace } from '@shared/bootTrace';
import { reportAppError } from '../../utils/reportAppError';
import { retryLazyImport } from '../../utils/lazyRetry';
import {
  IconClock,
  IconCovers,
  IconMoney,
  IconUsers,
} from '../../components/icons';

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
  const cachedSettings = peekSettings<any>();
  const cachedAreas = cachedSettings
    ? saneTableAreas(cachedSettings?.tableAreas)
    : [];
  const [area, setArea] = useState<string>(() =>
    pickConfiguredArea('', cachedAreas),
  );
  const [areas, setAreas] = useState<{ name: string; count: number }[]>(
    () => cachedAreas,
  );
  const [areasReady, setAreasReady] = useState(
    () => cachedAreas.length > 0 || Boolean(cachedSettings),
  );
  const { user } = useSessionStore();
  const [viewMode, setViewMode] = useState<ViewMode>('occupied');
  const [currency, setCurrency] = useState<string>('EUR');
  const { setSelectedTable, pendingAction, setPendingAction } =
    useOrderContext();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const traceArea = String(params.get('area') || '').trim();
  const traceTable = String(params.get('table') || '').trim();

  const openMap = useTableStatus((s) => s.openMap);
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

  const [openLoaded, setOpenLoaded] = useState(() => {
    const snap = peekFloorSnapshot(pickConfiguredArea('', cachedAreas));
    return (
      Boolean(snap?.tables?.length) ||
      Object.keys(useTableStatus.getState().openMap).length > 0
    );
  });
  const [openLoadError, setOpenLoadError] = useState<string | null>(null);
  const [mergeGroups, setMergeGroups] = useState<TableMergeGroup[]>([]);

  const reloadMerges = useCallback(async () => {
    if (!area) {
      setMergeGroups([]);
      return;
    }
    const groups = await window.api.layout
      .getMerges(area)
      .catch((e: unknown) => {
        reportAppError(e, {
          fallback: t('tables.mergesLoadFailed'),
          key: `layout.merges:${area}`,
        });
        return [];
      });
    setMergeGroups(sanitizeMergeGroups(groups));
  }, [area, t]);

  useEffect(() => {
    void reloadMerges();
  }, [reloadMerges]);

  useEffect(() => {
    if (!traceArea) return;
    if (areas.some((a) => a.name === traceArea)) setArea(traceArea);
  }, [traceArea, areas]);

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
        const openKeys = Object.entries(useTableStatus.getState().openMap)
          .filter(([, open]) => open)
          .map(([k]) => k);
        useTicketStore.getState().dropOrphanLiveBills(openKeys);
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:tablesChanged', onChanged);
    return () => window.removeEventListener('pos:tablesChanged', onChanged);
  }, [setOpen]);

  const { hydrate, bindTable } = useTicketStore();

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

  const applySnapshot = useCallback(
    (
      snap: FloorSnapshot,
      names: Record<number, string>,
      scopeArea?: string,
    ) => {
      const tables: FloorTableSnapshot[] = Array.isArray(snap?.tables)
        ? snap.tables
        : [];
      if (scopeArea) {
        const prefix = `${scopeArea}:`;
        const others = Object.entries(useTableStatus.getState().openMap)
          .filter(([k, open]) => open && !k.startsWith(prefix))
          .map(([k]) => {
            const idx = k.indexOf(':');
            return { area: k.slice(0, idx), label: k.slice(idx + 1) };
          })
          .filter((e) => e.area && e.label);
        applyHostOpenTables([
          ...others,
          ...tables.map((r) => ({ area: r.area, label: r.label })),
        ]);
      } else {
        applyHostOpenTables(
          tables.map((r) => ({ area: r.area, label: r.label })),
        );
      }
      const mergeScoped = <T,>(
        setter: (
          update: (prev: Record<string, T>) => Record<string, T>,
        ) => void,
        next: Record<string, T>,
      ) => {
        setter((prev) => {
          if (!scopeArea) return next;
          const prefix = `${scopeArea}:`;
          const merged = { ...prev };
          for (const k of Object.keys(merged)) {
            if (k.startsWith(prefix)) delete merged[k];
          }
          return { ...merged, ...next };
        });
      };
      const initials: Record<string, string> = {};
      const owners: Record<string, number> = {};
      const metrics: Record<string, { covers: number | null; total: number }> =
        {};
      const opened: Record<string, string> = {};
      for (const row of tables) {
        const k = `${row.area}:${row.label}`;
        if (row.userId) {
          owners[k] = row.userId;
          const name = names[row.userId];
          if (name) initials[k] = toInitials(name);
        }
        metrics[k] = { covers: row.covers, total: row.total };
        if (row.openedAt) opened[k] = row.openedAt;
      }
      mergeScoped(setInitialsByTable, initials);
      mergeScoped(setOwnerByTable, owners);
      mergeScoped(setMetricsByTable, metrics);
      mergeScoped(setOpenedAtByTable, opened);
    },
    [],
  );

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
    const cached = peekSettings<any>();
    if (cached) {
      setCurrency(
        String(cached?.currency || 'EUR')
          .trim()
          .toUpperCase() || 'EUR',
      );
      const nextAreas = saneTableAreas(cached?.tableAreas);
      if (nextAreas.length) {
        setAreas(nextAreas);
        setArea((current) => pickConfiguredArea(current, nextAreas));
        setAreasReady(true);
      }
    }
    void load();
    void prefetchHotReads();
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
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const cachedSnap = peekFloorSnapshot(area);
    if (cachedSnap) {
      applySnapshot(cachedSnap, userMap, area || undefined);
      setOpenLoaded(true);
    }

    const load = async (showError = false) => {
      try {
        if (isHidden()) {
          if (!cancelled && gen === pollGenRef.current) setOpenLoaded(true);
          return;
        }
        const api = window.api as any;
        let snap: FloorSnapshot | null = null;
        if (typeof api.tables?.getFloorSnapshot === 'function') {
          snap = await readFloorSnapshot(area || undefined);
        }
        if (cancelled || gen !== pollGenRef.current) return;
        if (snap && Array.isArray(snap.tables)) {
          applySnapshot(snap, userMap, area || undefined);
        } else {
          const open = await window.api.tables.listOpen();
          if (cancelled || gen !== pollGenRef.current) return;
          if (Array.isArray(open)) applyHostOpenTables(open);
        }
        setOpenLoaded(true);
        bootTrace('floor:snapshot');
        setOpenLoadError(null);
      } catch {
        if (!cancelled && gen === pollGenRef.current) {
          setOpenLoaded(true);
          if (showError) {
            setOpenLoadError(
              'Loading occupied tables… (slow/offline network). Retrying…',
            );
          }
        }
      }
    };

    const nextPollMs = () =>
      isSseHealthy() && !isHidden() ? 20_000 : pollIntervalMs(4000, isHidden());

    const poll = async () => {
      await load(false);
      if (!cancelled && gen === pollGenRef.current) {
        timer = setTimeout(poll, nextPollMs());
      }
    };

    void load(true).then(() => {
      if (!cancelled && gen === pollGenRef.current) {
        timer = setTimeout(poll, nextPollMs());
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [applySnapshot, area, userMap]);

  const openLabelsInArea = useMemo(() => {
    if (!area) return [] as string[];
    const prefix = `${area}:`;
    return Object.keys(openMap)
      .filter((k) => openMap[k] && k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }, [area, openMapKey, openMap]);

  useEffect(() => {
    const refresh = () => {
      const api = window.api as any;
      if (typeof api.tables?.getFloorSnapshot !== 'function') return;
      void readFloorSnapshot(area || undefined)
        .then((snap: FloorSnapshot | null) => {
          if (snap) applySnapshot(snap, userMap, area || undefined);
        })
        .catch(() => undefined);
    };
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
        refresh();
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:ticketsChanged', onTicketsChanged);
    window.addEventListener('pos:tablesChanged', refresh);
    window.addEventListener('pos:syncCatchup', refresh);
    return () => {
      window.removeEventListener('pos:ticketsChanged', onTicketsChanged);
      window.removeEventListener('pos:tablesChanged', refresh);
      window.removeEventListener('pos:syncCatchup', refresh);
    };
  }, [area, userMap, applySnapshot]);
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
      void retryLazyImport(() => import('./OrderPage'));
      const labels = (members?.length ? members : [label]).filter(Boolean);
      const openLabel =
        labels.find((l) => isOpenFn(area, l)) || labels[0] || label;
      setSelectedTable({ id: 0, label: openLabel, area });
      bindTable(tableKey(area, openLabel), {
        keepLiveBill: isOpenFn(area, openLabel),
      });
      const action = pendingAction;
      if (action) setPendingAction(null);
      if (isOpenFn(area, openLabel)) {
        const peeked = peekTableBill(area, openLabel);
        if (peeked) {
          hydrate({ items: peeked.items as any, note: peeked.note });
        }
        navigate('/app/order');
        return;
      }
      navigate('/app/order');
    },
    [
      area,
      pendingAction,
      setPendingAction,
      setSelectedTable,
      isOpenFn,
      hydrate,
      bindTable,
      navigate,
    ],
  );

  if (!areasReady && !openLoaded) {
    return <PageSpinner message={openLoadError || t('tables.loading')} />;
  }

  return (
    <div className="h-full min-h-0 relative overflow-hidden bg-[var(--pos-floor-bg)]">
      <h1 className="sr-only">{t('layout.tables')}</h1>
      <div className="absolute inset-0 flex flex-col">
        {areasReady && !area ? (
          <div className="flex-1 flex items-center justify-center text-sm text-[color:var(--pos-fg-muted)] px-6 text-center">
            {t('tables.noAreas')}
          </div>
        ) : null}
        {user && area ? (
          <FloorCanvas
            key={`${user.id}:${area}`}
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
            highlightLabels={traceTable ? [traceTable] : undefined}
            onTableClick={handleTableClick}
          />
        ) : null}
      </div>

      <div className="absolute top-0 left-0 right-0 z-10 flex items-start justify-end gap-3 px-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-3 pointer-events-none">
        <div className="pointer-events-auto flex gap-2 overflow-x-auto no-scrollbar max-w-full">
          {areas.map((a) => (
            <button
              key={a.name}
              type="button"
              aria-pressed={area === a.name}
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

      <div className="absolute bottom-0 left-0 right-0 z-10 flex justify-center px-3 pb-3 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))] pointer-events-none">
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
      className={`pos-floor-mode ${active ? 'pos-floor-mode--active' : ''}`}
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
