import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import {
  useOrderContext,
  type PendingAction,
} from '@shared/stores/orderContext';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTableStatus } from '../../stores/tableStatus';
import { useTicketStore } from '../../stores/ticket';
import { tableKey } from '@shared/utils/tableKey';
import { formatMoneyCompact } from '../../utils/format';
import { PageSpinner } from '../../components/PageSpinner';
import { pickConfiguredArea, saneTableAreas } from '@shared/tableAreas';
import FloorCanvas from '../components/FloorCanvas';
import {
  formatMergeLabel,
  sanitizeMergeGroups,
  type TableMergeGroup,
} from '@shared/tableMerge';
import type { FloorSnapshot, FloorTableSnapshot } from '@shared/ipc';
import { isSseHealthy, pollIntervalMs } from '../../utils/netQuality';
import {
  peekFloorSnapshot,
  peekSettings,
  prefetchHotReads,
  readFloorSnapshot,
} from '../../utils/posReadCache';
import { peekTableBill } from '../../utils/tableBill';
import { loadOpenTableBill } from '../../utils/ticketRead';
import { applyHostOpenTables } from '../../utils/openTablesSync';
import {
  resolveBootFloorArea,
  writeLastFloorArea,
} from '../../utils/floorAreaPref';
import { buildReportPrintPayload } from './reportsReceipt';
import { printTicket } from '../../api';
import { toast } from '../../stores/toasts';
import { bootTrace } from '@shared/bootTrace';
import { reportAppError } from '../../utils/reportAppError';
import { retryLazyImport } from '../../utils/lazyRetry';
import {
  IconCard,
  IconClock,
  IconCovers,
  IconMoney,
  IconPrinter,
  IconUsers,
} from '../../components/icons';

type ViewMode = 'occupied' | 'covers' | 'revenue' | 'time';

type TableFloorMenu = {
  label: string;
  members: string[];
  x: number;
  y: number;
};

const RED = 'bg-rose-700';
const ORANGE = 'bg-amber-700';

function clampMenuPos(x: number, y: number, width = 224, height = 168) {
  const pad = 8;
  const left = Math.max(pad, Math.min(x, window.innerWidth - width - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - height - pad));
  return { left, top };
}
function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0)
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function occupancyFingerprint(snap: FloorSnapshot): string {
  const tables: FloorTableSnapshot[] = Array.isArray(snap?.tables)
    ? snap.tables
    : [];
  return tables
    .map(
      (row) =>
        `${row.area}\t${row.label}\t${row.userId ?? ''}\t${row.covers ?? ''}\t${row.total}\t${row.openedAt ?? ''}`,
    )
    .sort()
    .join('\n');
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
  const { setSelectedTable, setPendingAction } = useOrderContext();
  const [tableMenu, setTableMenu] = useState<TableFloorMenu | null>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const [area, setAreaState] = useState<string>(() =>
    resolveBootFloorArea(
      cachedAreas,
      useOrderContext.getState().selectedTable?.area,
    ),
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
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const traceArea = String(params.get('area') || '').trim();
  const traceTable = String(params.get('table') || '').trim();

  const setArea = useCallback((next: string) => {
    setAreaState(String(next || '').trim());
  }, []);

  // Keep the floor sticky across Order ↔ Tables remounts.
  useEffect(() => {
    if (!area) return;
    writeLastFloorArea(area);
    const cur = String(params.get('area') || '').trim();
    if (cur === area) return;
    const q = new URLSearchParams(params);
    q.set('area', area);
    setParams(q, { replace: true });
  }, [area, params, setParams]);

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
    const bootArea = resolveBootFloorArea(
      cachedAreas,
      useOrderContext.getState().selectedTable?.area,
    );
    const snap = peekFloorSnapshot(bootArea);
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

  const hydrate = useTicketStore((s) => s.hydrate);
  const bindTable = useTicketStore((s) => s.bindTable);

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
        setAreaState((current) => pickConfiguredArea(current, nextAreas));
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
        setAreaState((current) => pickConfiguredArea(current, nextAreas));
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
  const occupancyKeyRef = useRef('');
  useEffect(() => {
    const gen = ++pollGenRef.current;
    occupancyKeyRef.current = '';
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const cachedSnap = peekFloorSnapshot(area);
    if (cachedSnap) {
      occupancyKeyRef.current = occupancyFingerprint(cachedSnap);
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
          const key = occupancyFingerprint(snap);
          if (key !== occupancyKeyRef.current) {
            occupancyKeyRef.current = key;
            applySnapshot(snap, userMap, area || undefined);
          }
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
      void reloadMerges();
      void readFloorSnapshot(area || undefined)
        .then((snap: FloorSnapshot | null) => {
          if (!snap) return;
          const key = occupancyFingerprint(snap);
          if (key === occupancyKeyRef.current) return;
          occupancyKeyRef.current = key;
          applySnapshot(snap, userMap, area || undefined);
        })
        .catch(() => undefined);
    };
    const paintFromCache = () => {
      const snap = peekFloorSnapshot(area);
      if (!snap) return;
      const key = occupancyFingerprint(snap);
      if (key === occupancyKeyRef.current) return;
      occupancyKeyRef.current = key;
      applySnapshot(snap, userMap, area || undefined);
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
        paintFromCache();
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:ticketsChanged', onTicketsChanged);
    window.addEventListener('pos:tablesChanged', paintFromCache);
    window.addEventListener('pos:syncCatchup', refresh);
    return () => {
      window.removeEventListener('pos:ticketsChanged', onTicketsChanged);
      window.removeEventListener('pos:tablesChanged', paintFromCache);
      window.removeEventListener('pos:syncCatchup', refresh);
    };
  }, [area, userMap, applySnapshot, reloadMerges]);
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

  const openTable = useCallback(
    (label: string, members?: string[], opts?: { pending?: PendingAction }) => {
      void retryLazyImport(() => import('./OrderPage'));
      const labels = (members?.length ? members : [label]).filter(Boolean);
      const openLabel =
        labels.find((l) => isOpenFn(area, l)) || labels[0] || label;
      const isOpen = isOpenFn(area, openLabel);
      setPendingAction(opts?.pending ?? null);
      setSelectedTable({ id: 0, label: openLabel, area });
      bindTable(tableKey(area, openLabel), {
        keepLiveBill: isOpen,
      });
      if (isOpen) {
        const peeked = peekTableBill(area, openLabel);
        const navOpts =
          opts?.pending === 'pay'
            ? { state: { openPayment: true, focusTicket: true } }
            : undefined;
        if (peeked) {
          hydrate({ items: peeked.items as any, note: peeked.note });
        } else {
          // Floor polls ship total but items:[], so peeks often miss. Do not
          // await the host bill — that LAN RTT is what made occupied taps
          // feel stuck on phones. OrderPage still syncs on mount; this
          // background hydrate can fill the cart while the chunk loads.
          void loadOpenTableBill(area, openLabel)
            .then((bill) => {
              if (bill) {
                hydrate({ items: bill.items as any, note: bill.note });
              }
            })
            .catch(() => undefined);
        }
        navigate('/app/order', navOpts);
        return;
      }
      navigate(
        '/app/order',
        opts?.pending === 'pay'
          ? { state: { openPayment: true, focusTicket: true } }
          : undefined,
      );
    },
    [
      area,
      setPendingAction,
      setSelectedTable,
      isOpenFn,
      hydrate,
      bindTable,
      navigate,
    ],
  );

  const handleTableClick = useCallback(
    (label: string, members?: string[]) => {
      setTableMenu(null);
      openTable(label, members);
    },
    [openTable],
  );

  const openTableMenu = useCallback(
    (info: {
      label: string;
      members?: string[];
      clientX: number;
      clientY: number;
    }) => {
      const members = info.members?.length ? info.members : [info.label];
      const openLabel =
        members.find((l) => isOpenFn(area, l)) || members[0] || info.label;
      if (!isOpenFn(area, openLabel)) {
        toast.warn(t('tables.menuNeedsOpen'));
        return;
      }
      setTableMenu({
        label: info.label,
        members,
        x: info.clientX,
        y: info.clientY,
      });
    },
    [area, isOpenFn, t],
  );

  useEffect(() => {
    if (!tableMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTableMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tableMenu]);

  useEffect(() => {
    setTableMenu(null);
  }, [area]);

  const printMenuTicket = useCallback(async () => {
    if (!tableMenu || menuBusy) return;
    const members = tableMenu.members.length
      ? tableMenu.members
      : [tableMenu.label];
    const openLabel =
      members.find((l) => isOpenFn(area, l)) || members[0] || tableMenu.label;
    setTableMenu(null);
    if (!isOpenFn(area, openLabel)) {
      toast.warn(t('tables.menuNeedsOpen'));
      return;
    }
    setMenuBusy(true);
    try {
      const peeked = peekTableBill(area, openLabel);
      const bill =
        peeked ?? (await loadOpenTableBill(area, openLabel).catch(() => null));
      const payload = buildReportPrintPayload(
        {
          kind: 'ACTIVE',
          area,
          tableLabel: openLabel,
          items: bill?.items,
          note: bill?.note,
        },
        {
          userId: user?.id,
          userName: user?.displayName,
        },
      );
      if (!payload) {
        toast.warn(t('tables.menuNoItems'));
        return;
      }
      const printed = await printTicket(payload);
      if (printed?.queued) {
        toast.warn(t('order.ticketPrintQueued'));
      } else {
        toast.success(t('reports.ticketPrinted'));
      }
    } catch (e: unknown) {
      reportAppError(e, {
        fallback: t('reports.printTicketFailed'),
        key: `tables.print:${area}:${openLabel}`,
      });
      toast.warn(t('order.ticketPrintQueued'));
    } finally {
      setMenuBusy(false);
    }
  }, [tableMenu, menuBusy, area, isOpenFn, t, user?.id, user?.displayName]);

  const payMenuTicket = useCallback(() => {
    if (!tableMenu || menuBusy) return;
    const { label, members } = tableMenu;
    setTableMenu(null);
    const openLabel =
      (members.length ? members : [label]).find((l) => isOpenFn(area, l)) ||
      label;
    if (!isOpenFn(area, openLabel)) {
      toast.warn(t('tables.menuNeedsOpen'));
      return;
    }
    openTable(label, members, { pending: 'pay' });
  }, [tableMenu, menuBusy, area, isOpenFn, t, openTable]);

  const menuMembers = tableMenu?.members?.length
    ? tableMenu.members
    : tableMenu
      ? [tableMenu.label]
      : [];
  const menuDisplayLabel = menuMembers.length
    ? formatMergeLabel(menuMembers)
    : tableMenu?.label || '';
  const menuPos = tableMenu
    ? clampMenuPos(tableMenu.x, tableMenu.y)
    : { left: 0, top: 0 };

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
            fitPadding={{ x: 8, y: 88 }}
            emptyMessage={t('tables.noLayout')}
            colorByLabel={colorByLabel}
            badgeByLabel={badgeByLabel}
            mergeGroups={mergeGroups}
            highlightLabels={traceTable ? [traceTable] : undefined}
            onTableClick={handleTableClick}
            onTableLongPress={openTableMenu}
          />
        ) : null}
      </div>

      {tableMenu ? (
        <div className="fixed inset-0 z-50" onClick={() => setTableMenu(null)}>
          <div
            role="menu"
            className="absolute w-56 rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] shadow-2xl overflow-hidden"
            style={{ left: menuPos.left, top: menuPos.top }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-[var(--pos-border)]">
              <div className="text-[10px] uppercase tracking-wide text-[color:var(--pos-fg-muted)]">
                {t('tables.quickMenu')}
              </div>
              <div className="font-semibold truncate">
                {t('tables.tableLabel', { label: menuDisplayLabel })}
              </div>
            </div>
            <div className="p-1.5 space-y-1">
              <button
                type="button"
                role="menuitem"
                disabled={menuBusy}
                className="w-full flex items-center gap-2 text-left px-3 py-2.5 rounded text-sm font-medium hover:bg-[var(--pos-hover)] disabled:opacity-50"
                onClick={() => void printMenuTicket()}
              >
                <IconPrinter />
                <span>{t('order.printTicket')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={menuBusy}
                className="w-full flex items-center gap-2 text-left px-3 py-2.5 rounded text-sm font-medium hover:bg-[var(--pos-hover)] disabled:opacity-50"
                onClick={payMenuTicket}
              >
                <IconCard />
                <span>{t('tables.payTicket')}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
