import { useEffect, useMemo, useRef, useState } from 'react';
import { useTicketStore } from '../../stores/ticket';
import { useOrderContext } from '@shared/stores/orderContext';
import { useTableStatus } from '../../stores/tableStatus';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import { logTicket } from '../../api';
import { tryOrQueue } from '../../utils/offlineQueue';
import { useFavourites } from '../../stores/favourites';
import { makeFormatAmount } from '../../utils/format';
import { toast } from '../../stores/toasts';
import { PageSpinner } from '../../components/PageSpinner';

type MenuItemDTO = {
  id: number;
  name: string;
  sku: string;
  price: number;
  vatRate: number;
  active: boolean;
  categoryId: number;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
  isKg?: boolean;
};
type MenuCategoryDTO = {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  // Hex string set in Admin → Menu, e.g. "#10b981". Falls back to a
  // neutral slate background when the admin hasn't picked one yet.
  color?: string | null;
  items: MenuItemDTO[];
};

/**
 * Pick a readable foreground (white vs near-black) for an arbitrary
 * background hex via perceptual luminance. Keeps the price + name
 * legible whether the admin assigned a bright yellow or a dark navy.
 */
function readableTextColor(hex?: string | null): string {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Rec. 601 luma — fast and good enough for UI contrast picks.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0f172a' : '#ffffff';
}

const FALLBACK_TILE_BG = '#065f46'; // emerald-800 — matches the prior look

/** TABLE labels from saved layout JSON (same rules as ReservationsLayout / FloorCanvas). */
function labelsFromLayoutNodes(saved: any[] | null | undefined): string[] {
  if (!Array.isArray(saved) || !saved.length) return [];
  const out: string[] = [];
  for (const n of saved) {
    if (!n) continue;
    const kind = n.kind;
    if (String(kind || '').toUpperCase() === 'AREA') continue;
    if (kind != null && kind !== '' && String(kind).toUpperCase() !== 'TABLE') {
      continue;
    }
    const lab = String(n.label || '').trim();
    if (lab) out.push(lab);
  }
  return out;
}

function syntheticLabelsFromAreaDefaultCount(
  defaultTableCount: number,
): string[] {
  const raw = Number(defaultTableCount);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
  const capped = Math.max(1, Math.min(200, n));
  return Array.from({ length: capped }, (_, i) => `T${i + 1}`);
}

function sortNaturalTableLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) => {
    const an = Number((a.match(/\d+/) || ['0'])[0]);
    const bn = Number((b.match(/\d+/) || ['0'])[0]);
    if (an !== bn) return an - bn;
    return a.localeCompare(b);
  });
}

export default function OrderPage() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<MenuCategoryDTO[]>([]);
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const {
    lines,
    addItem,
    increment,
    decrement,
    setLineNote,
    orderNote,
    setOrderNote,
    clear,
    removeLine,
  } = useTicketStore();
  const [weightModal, setWeightModal] = useState<{
    sku: string;
    name: string;
    unitPrice: number;
    vatRate: number;
  } | null>(null);
  const [weightInput, setWeightInput] = useState<string>('');
  const { selectedTable, setPendingAction, setSelectedTable } =
    useOrderContext();
  const { setOpen, setAll, isOpen } = useTableStatus();
  const [openLoaded, setOpenLoaded] = useState(false);
  const [openLoadError, setOpenLoadError] = useState<string | null>(null);
  const [ticketLoaded, setTicketLoaded] = useState(false);
  const [showCovers, setShowCovers] = useState(false);
  const [coversValue, setCoversValue] = useState('');
  const [coversKnown, setCoversKnown] = useState<number | null | undefined>(
    undefined,
  );
  const [coversMode, setCoversMode] = useState<'openAndSend' | 'editOnly'>(
    'openAndSend',
  );
  const [showPayment, setShowPayment] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<
    'CASH' | 'CARD' | 'GIFT_CARD' | 'ROOM_CHARGE'
  >('CASH');
  const [amountPaid, setAmountPaid] = useState<string>('');
  const [printReceipt, setPrintReceipt] = useState<boolean>(true);
  const [discountType, setDiscountType] = useState<
    'NONE' | 'PERCENT' | 'AMOUNT'
  >('NONE');
  const [discountValue, setDiscountValue] = useState<string>('');
  const [discountReason, setDiscountReason] = useState<string>('');
  const [vatEnabled, setVatEnabled] = useState<boolean>(true);
  const [serviceChargeCfg, setServiceChargeCfg] = useState<{
    enabled: boolean;
    mode: 'PERCENT' | 'AMOUNT';
    value: number;
  }>({
    enabled: false,
    mode: 'PERCENT',
    value: 10,
  });
  const [applyServiceCharge, setApplyServiceCharge] = useState<boolean>(true);
  const [voidTarget, setVoidTarget] = useState<{
    id: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
    note?: string;
  } | null>(null);
  const navigate = useNavigate();
  const { user } = useSessionStore();
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [openedAtMs, setOpenedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const suppressFreeOnEmptyRef = useRef(false);
  const initialRenderRef = useRef(true);
  /**
   * Incremented on every void AND on every table switch; background effects
   * use it to cancel stale fetches so a slow response from a previous table
   * cannot overwrite state for the table the user is currently viewing.
   */
  const hydrateGenRef = useRef(0);
  /** Set when we send or are about to send; prevents overwriting with empty during server sync delay */
  const lastSendAtRef = useRef(0);
  const lastSendTableRef = useRef<{ area: string; label: string } | null>(null);
  const [requestLocked, setRequestLocked] = useState(false);
  const [busyAction, setBusyAction] = useState<
    'send' | 'pay' | 'void' | 'request' | null
  >(null);
  const isBrowserClient =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const backendOk =
    typeof window !== 'undefined'
      ? (window as any).__BACKEND_OK__ !== false
      : true;
  const netOk =
    typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  const connectionOk = !isBrowserClient || (netOk && backendOk);
  const [mobilePane, setMobilePane] = useState<'menu' | 'ticket'>('menu');
  const [ticketSyncing, setTicketSyncing] = useState(false);

  // Transfer table (move table and/or change owner)
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferMode, setTransferMode] = useState<'WAITER' | 'TABLE'>(
    'WAITER',
  );
  const [transferUsers, setTransferUsers] = useState<
    Array<{ id: number; displayName: string; role: string; active: boolean }>
  >([]);
  const [onShiftUserIds, setOnShiftUserIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [transferToUserId, setTransferToUserId] = useState<number | null>(null);
  const [transferToArea, setTransferToArea] = useState<string>('');
  const [transferToLabel, setTransferToLabel] = useState<string>('');
  const [transferTableSections, setTransferTableSections] = useState<
    { name: string; count: number }[]
  >([]);
  const [transferLayoutLabels, setTransferLayoutLabels] = useState<string[]>(
    [],
  );
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  const transferSectionNames = useMemo(() => {
    const fromSettings = transferTableSections
      .map((s) => String(s.name || '').trim())
      .filter(Boolean);
    const uniq = [...new Set(fromSettings)];
    if (selectedTable?.area && !uniq.includes(String(selectedTable.area))) {
      return [String(selectedTable.area), ...uniq];
    }
    return uniq.length
      ? uniq
      : selectedTable?.area
        ? [String(selectedTable.area)]
        : [];
  }, [transferTableSections, selectedTable?.area]);

  const transferDestTableOptions = useMemo(() => {
    return transferLayoutLabels.filter(
      (l) =>
        !(
          selectedTable &&
          String(transferToArea) === String(selectedTable.area) &&
          l === selectedTable.label
        ),
    );
  }, [
    transferLayoutLabels,
    transferToArea,
    selectedTable?.area,
    selectedTable?.label,
  ]);

  // Keep destination section aligned with the dropdown list once settings load.
  useEffect(() => {
    if (!showTransfer) return;
    if (!transferSectionNames.length) return;
    if (!transferSectionNames.includes(String(transferToArea))) {
      const fallback =
        (selectedTable?.area &&
        transferSectionNames.includes(String(selectedTable.area))
          ? String(selectedTable.area)
          : null) ?? transferSectionNames[0];
      if (fallback) setTransferToArea(fallback);
    }
  }, [showTransfer, transferSectionNames, transferToArea, selectedTable?.area]);

  const isTableOpen = selectedTable
    ? isOpen(selectedTable.area, selectedTable.label)
    : false;
  const hasUnsentItems = lines.some((l) => l.staged);
  const canTransfer = Boolean(
    selectedTable &&
      isOpen(selectedTable.area, selectedTable.label) &&
      user?.id &&
      (user.role === 'ADMIN' ||
        (ownerId != null && Number(ownerId) === Number(user.id))),
  );
  // Editing covers (guest count) requires the same ownership rule as transfer:
  // admins always pass, otherwise only the owning waiter may change covers.
  // When the table is open but ownerId hasn't been resolved yet (fresh open),
  // we allow editing — otherwise the very first set-covers would be impossible.
  const canEditCovers = Boolean(
    selectedTable &&
      isOpen(selectedTable.area, selectedTable.label) &&
      user?.id &&
      (user.role === 'ADMIN' ||
        ownerId == null ||
        Number(ownerId) === Number(user.id)),
  );

  function formatElapsed(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (hh > 0)
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  // Ensure table open/occupied status is loaded even when user refreshes on OrderPage.
  // Reset on mount so the loading screen shows until fresh data arrives.
  const orderPollGenRef = useRef(0);
  useEffect(() => {
    const gen = ++orderPollGenRef.current;
    setOpenLoaded(false);
    setTicketLoaded(false);
    let timer: any;
    let cancelled = false;
    const fetchOnce = async () => {
      const hidden =
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden';
      try {
        if (hidden) {
          if (!cancelled && gen === orderPollGenRef.current)
            setOpenLoaded(true);
          return;
        }
        const open = await window.api.tables.listOpen();
        if (cancelled || gen !== orderPollGenRef.current) return;
        if (Array.isArray(open)) setAll(open);
        setOpenLoaded(true);
        setOpenLoadError(null);
      } catch (e: any) {
        void e;
        if (!cancelled && gen === orderPollGenRef.current) {
          setOpenLoaded(true);
          setOpenLoadError('occ_tables_slow');
        }
      }
    };
    const poll = async () => {
      const hidden =
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden';
      try {
        if (hidden) return;
        const open = await window.api.tables.listOpen();
        if (cancelled || gen !== orderPollGenRef.current) return;
        if (Array.isArray(open)) setAll(open);
      } catch {
        // ignore poll errors
      } finally {
        if (!cancelled && gen === orderPollGenRef.current) {
          timer = setTimeout(poll, hidden ? 12000 : 4000);
        }
      }
    };
    fetchOnce().then(() => {
      if (!cancelled && gen === orderPollGenRef.current) {
        timer = setTimeout(poll, 4000);
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [setAll]);

  // Live "table open" timer (uses session start from tickets tooltip, which is based on tables:openAt)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedTable) {
        setOpenedAtMs(null);
        return;
      }
      if (!isOpen(selectedTable.area, selectedTable.label)) {
        setOpenedAtMs(null);
        return;
      }
      const tip = await window.api.tickets
        .getTableTooltip(selectedTable.area, selectedTable.label)
        .catch(() => null);
      const iso = (tip as any)?.firstAt as string | null | undefined;
      const t = iso ? new Date(iso).getTime() : NaN;
      if (cancelled) return;
      setOpenedAtMs(Number.isFinite(t) ? t : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
  ]);

  useEffect(() => {
    if (!openedAtMs) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [openedAtMs]);

  // CORRECTNESS: bump the hydrate generation whenever the selected table
  // changes. Previously hydrateGenRef was only bumped on void; a slow IPC
  // response from a previous table could land after the user had switched and
  // overwrite state for the new table.
  useEffect(() => {
    hydrateGenRef.current += 1;
  }, [selectedTable?.area, selectedTable?.label]);

  // Load ticket snapshot for open tables before rendering the page (prevents empty->pop-in on refresh).
  useEffect(() => {
    let cancelled = false;
    const gen = hydrateGenRef.current;
    (async () => {
      if (!openLoaded) return;
      if (!selectedTable) {
        setTicketLoaded(true);
        return;
      }
      // When table is not open, ticket is a new draft (no need to wait).
      if (!isOpen(selectedTable.area, selectedTable.label)) {
        setTicketLoaded(true);
        return;
      }
      setTicketLoaded(false);
      try {
        const latest = await window.api.tickets.getLatestForTable(
          selectedTable.area,
          selectedTable.label,
        );
        if (cancelled || gen !== hydrateGenRef.current) return;
        const items = Array.isArray(latest?.items) ? latest!.items : [];
        const remaining = items.filter((it: any) => !it.voided);
        if (remaining.length) {
          useTicketStore
            .getState()
            .hydrate({ items: remaining as any, note: latest?.note || '' });
        } else {
          const currentLines = useTicketStore.getState().lines;
          const sentTable = lastSendTableRef.current;
          const isSameTable =
            sentTable &&
            selectedTable &&
            sentTable.area === selectedTable.area &&
            sentTable.label === selectedTable.label;
          const withinPostSendGrace =
            currentLines.length > 0 &&
            Date.now() - lastSendAtRef.current < 5000 &&
            isSameTable;
          if (withinPostSendGrace) {
            // Don't overwrite with empty — we may have just sent; server may not have synced yet
            return;
          }
          useTicketStore
            .getState()
            .hydrate({ items: [], note: latest?.note || '' });
          // Table open but no items (opened with covers, never added items) — free it
          if (selectedTable) {
            setOpen(selectedTable.area, selectedTable.label, false);
            window.api.tables
              .setOpen(selectedTable.area, selectedTable.label, false)
              .catch(() => {});
          }
        }
      } catch (e) {
        void e;
      } finally {
        if (!cancelled && gen === hydrateGenRef.current) setTicketLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    openLoaded,
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
  ]);

  // Track covers for the selected table (used to gate "Pay")
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedTable) {
        setCoversKnown(undefined);
        return;
      }
      if (!isTableOpen) {
        // `undefined` = “table closed / not applicable”; avoids wiping an
        // optimistic covers count while we're awaiting IPC during the
        // open-and-send handshake (see covers modal handler).
        setCoversKnown(undefined);
        return;
      }
      try {
        const last = await window.api.covers.getLast(
          selectedTable.area,
          selectedTable.label,
        );
        if (cancelled) return;
        setCoversKnown(last ?? null);
      } catch {
        if (cancelled) return;
        setCoversKnown(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedTable?.area, selectedTable?.label, isTableOpen]);

  const canPay =
    Boolean(selectedTable) &&
    lines.length > 0 &&
    isTableOpen &&
    !hasUnsentItems &&
    typeof coversKnown === 'number' &&
    coversKnown > 0;

  const totals = useMemo(
    () => computeTotals(lines, vatEnabled),
    [lines, vatEnabled],
  );
  const [approvalsCfg, setApprovalsCfg] = useState<{
    requireManagerPinForDiscount: boolean;
    requireManagerPinForVoid: boolean;
    requireManagerPinForServiceChargeRemoval: boolean;
  }>({
    requireManagerPinForDiscount: true,
    requireManagerPinForVoid: true,
    requireManagerPinForServiceChargeRemoval: true,
  });

  const [approvalModal, setApprovalModal] = useState<{
    open: boolean;
    action: string;
    kind: 'MANAGER' | 'ADMIN';
    pin: string;
    error: string | null;
  }>({ open: false, action: '', kind: 'MANAGER', pin: '', error: null });
  const approvalResolveRef = useRef<
    | ((
        v: { userId: number; userName: string; approvalToken?: string } | null,
      ) => void)
    | null
  >(null);

  function requestManagerApproval(action: string) {
    setApprovalModal({
      open: true,
      action,
      kind: 'MANAGER',
      pin: '',
      error: null,
    });
    return new Promise<{ userId: number; userName: string } | null>(
      (resolve) => {
        approvalResolveRef.current = resolve;
      },
    );
  }

  function requestAdminApproval(action: string) {
    setApprovalModal({
      open: true,
      action,
      kind: 'ADMIN',
      pin: '',
      error: null,
    });
    return new Promise<{ userId: number; userName: string } | null>(
      (resolve) => {
        approvalResolveRef.current = resolve;
      },
    );
  }

  async function reloadPreferences() {
    try {
      const s: any = await window.api.settings.get().catch(() => null);
      setVatEnabled((s as any)?.preferences?.vatEnabled !== false);
      const sc = (s as any)?.preferences?.serviceCharge || {};
      const enabled = Boolean(sc.enabled);
      const mode =
        String(sc.mode || 'PERCENT').toUpperCase() === 'AMOUNT'
          ? 'AMOUNT'
          : 'PERCENT';
      const value = Number(sc.value ?? 10);
      setServiceChargeCfg({
        enabled,
        mode,
        value: Number.isFinite(value) ? value : 10,
      });
      const approvals = (s as any)?.security?.approvals || {};
      setApprovalsCfg({
        requireManagerPinForDiscount:
          approvals.requireManagerPinForDiscount !== false,
        requireManagerPinForVoid: approvals.requireManagerPinForVoid !== false,
        requireManagerPinForServiceChargeRemoval:
          approvals.requireManagerPinForServiceChargeRemoval !== false,
      });
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void reloadPreferences();
    // Keep prefs fresh when admin changes them in another window/tab.
    const onFocus = () => {
      void reloadPreferences();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const serviceChargeAmount = useMemo(() => {
    if (!serviceChargeCfg.enabled || !applyServiceCharge) return 0;
    const base = Number(totals.total || 0);
    if (!Number.isFinite(base) || base <= 0) return 0;
    const v = Number(serviceChargeCfg.value || 0);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (serviceChargeCfg.mode === 'PERCENT')
      return Math.max(0, (base * v) / 100);
    return Math.max(0, v);
  }, [
    serviceChargeCfg.enabled,
    serviceChargeCfg.mode,
    serviceChargeCfg.value,
    applyServiceCharge,
    totals.total,
  ]);

  // Service charge amount as configured (ignores waiter toggle). Used for approval checks.
  const serviceChargeConfiguredAmount = useMemo(() => {
    if (!serviceChargeCfg.enabled) return 0;
    const base = Number(totals.total || 0);
    if (!Number.isFinite(base) || base <= 0) return 0;
    const v = Number(serviceChargeCfg.value || 0);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (serviceChargeCfg.mode === 'PERCENT')
      return Math.max(0, (base * v) / 100);
    return Math.max(0, v);
  }, [
    serviceChargeCfg.enabled,
    serviceChargeCfg.mode,
    serviceChargeCfg.value,
    totals.total,
  ]);

  const totalBeforeDiscount = Math.max(
    0,
    Number(totals.total || 0) + serviceChargeAmount,
  );
  const discountAmount = useMemo(() => {
    const base = Number(totalBeforeDiscount || 0);
    if (!Number.isFinite(base) || base <= 0) return 0;
    const raw = Number(String(discountValue || '').replace(',', '.'));
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    if (discountType === 'PERCENT') return Math.min(base, (base * raw) / 100);
    if (discountType === 'AMOUNT') return Math.min(base, raw);
    return 0;
  }, [discountType, discountValue, totalBeforeDiscount]);
  const totalDue = Math.max(0, totalBeforeDiscount - discountAmount);
  const formatAmount = useMemo(() => makeFormatAmount(), []);

  const fav = useFavourites();
  const favouriteSkus = fav.list(user?.id || null);
  const selected = useMemo(() => {
    // Virtual Favourites category id: -1
    if (selectedCatId === -1) {
      const items = categories
        .flatMap((c) => c.items)
        .filter((i) => favouriteSkus.includes(i.sku));
      return {
        id: -1,
        name: t('order.favourites'),
        sortOrder: -999,
        active: true,
        items,
      } as any;
    }
    return categories.find((c) => c.id === selectedCatId) ?? categories[0];
  }, [categories, selectedCatId, favouriteSkus, t]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    // If there is a search query, search across all categories' items
    if (q) {
      return categories
        .flatMap((c) => c.items)
        .filter(
          (i: any) =>
            i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q),
        );
    }
    // Otherwise, show items from the selected category (or first category)
    return selected ? selected.items : categories.flatMap((c) => c.items);
  }, [categories, selected, query]);

  const loadMenu = async () => {
    const data = await window.api.menu.listCategoriesWithItems();
    setCategories(data);
    if (data.length && !selectedCatId) setSelectedCatId(data[0].id);
  };

  const categoryNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories as any[])
      m.set(Number(c.id), String(c.name || ''));
    return m;
  }, [categories]);

  const categoryColorById = useMemo(() => {
    const m = new Map<number, string | null>();
    for (const c of categories as any[]) {
      m.set(Number(c.id), c?.color ? String(c.color) : null);
    }
    return m;
  }, [categories]);

  useEffect(() => {
    loadMenu();
  }, []);

  // Prefill transfer UI when opened. We pull the user list AND the set of
  // currently-on-shift userIds in parallel so the "To waiter" dropdown only
  // shows colleagues who are clocked in. Server-side `transferTableLocal`
  // re-checks this — the client filter is purely a UX hint.
  // We also load `tableAreas` from settings so "To table" can use section +
  // layout-driven table selects (no free text).
  useEffect(() => {
    if (!showTransfer) return;
    if (!selectedTable) return;
    setTransferError(null);
    setTransferToArea(selectedTable.area);
    setTransferToLabel('');
    setTransferLayoutLabels([]);
    setTransferToUserId(null);
    let cancelled = false;
    (async () => {
      const [users, openIds, settings] = await Promise.all([
        window.api.auth.listUsers().catch(() => [] as any[]),
        window.api.shifts.listOpen().catch(() => [] as number[]),
        window.api.settings.get().catch(() => null as any),
      ]);
      if (cancelled) return;
      setTransferUsers(
        (Array.isArray(users) ? users : []).filter((u: any) => u && u.active),
      );
      setOnShiftUserIds(
        new Set((Array.isArray(openIds) ? openIds : []).map((n) => Number(n))),
      );
      const list: { name: string; count: number }[] =
        (settings?.tableAreas as any) || [];
      setTransferTableSections(Array.isArray(list) ? list : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [showTransfer, selectedTable?.area, selectedTable?.label]);

  // Load TABLE labels for the chosen destination section from the saved floor
  // layout (same source as TablesPage / reservations). Falls back to T1…N from
  // the section default count when no layout exists yet.
  useEffect(() => {
    if (!showTransfer || transferMode !== 'TABLE' || !user?.id) return;
    const areaName = String(transferToArea || '').trim();
    if (!areaName || !selectedTable) {
      setTransferLayoutLabels([]);
      setTransferToLabel('');
      return;
    }

    setTransferLayoutLabels([]);

    let cancelled = false;
    const load = async () => {
      const meta = transferTableSections.find(
        (a) => String(a.name) === String(areaName),
      );
      const count =
        meta && Number(meta.count) > 0 && Number.isFinite(Number(meta.count))
          ? Number(meta.count)
          : 8;
      const saved = await window.api.layout
        .get(user.id, areaName)
        .catch(() => null);
      if (cancelled) return;
      const fromSaved = labelsFromLayoutNodes(
        Array.isArray(saved) ? saved : null,
      );
      const labels =
        fromSaved.length > 0
          ? sortNaturalTableLabels(fromSaved)
          : sortNaturalTableLabels(syntheticLabelsFromAreaDefaultCount(count));

      const available = labels.filter(
        (l) =>
          !(
            String(areaName) === String(selectedTable.area) &&
            l === selectedTable.label
          ),
      );

      setTransferLayoutLabels(labels);
      setTransferToLabel((prev) => {
        if (prev && available.includes(prev)) return prev;
        return available[0] ?? '';
      });
    };

    void load();

    const onLayout = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as { area?: string };
        if (!detail.area || !areaName || detail.area !== areaName) return;
        void load();
      } catch {
        void load();
      }
    };
    window.addEventListener('pos:layoutChanged', onLayout);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:layoutChanged', onLayout);
    };
  }, [
    showTransfer,
    transferMode,
    user?.id,
    transferToArea,
    transferTableSections,
    selectedTable?.area,
    selectedTable?.label,
  ]);

  // Determine owner of the currently selected open table
  useEffect(() => {
    const gen = hydrateGenRef.current;
    (async () => {
      if (!selectedTable) {
        setOwnerId(null);
        return;
      }
      if (!isOpen(selectedTable.area, selectedTable.label)) {
        setOwnerId(null);
        return;
      }
      try {
        const data = await window.api.tickets.getLatestForTable(
          selectedTable.area,
          selectedTable.label,
        );
        if (gen !== hydrateGenRef.current) return;
        setOwnerId(data?.userId ?? null);
      } catch {
        if (gen !== hydrateGenRef.current) return;
        setOwnerId(null);
      }
    })();
  }, [
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
  ]);

  // Hydrate lines from server when selecting a table or on refresh.
  // Skip while ticketSyncing — the void flow handles its own re-sync.
  useEffect(() => {
    if (ticketSyncing) return;
    const gen = hydrateGenRef.current;
    (async () => {
      if (!selectedTable) return;
      // Only hydrate for tables currently marked as open
      if (!isOpen(selectedTable.area, selectedTable.label)) return;
      try {
        const latest = await window.api.tickets.getLatestForTable(
          selectedTable.area,
          selectedTable.label,
        );
        // Stale fetch — a void or new action happened while this was in flight
        if (gen !== hydrateGenRef.current) return;
        const items = Array.isArray(latest?.items) ? latest!.items : [];
        const remaining = items.filter((it: any) => !it.voided);
        if (remaining.length) {
          useTicketStore
            .getState()
            .hydrate({ items: remaining as any, note: latest?.note || '' });
        } else {
          const currentLines = useTicketStore.getState().lines;
          const sentTable = lastSendTableRef.current;
          const isSameTable =
            sentTable &&
            selectedTable &&
            sentTable.area === selectedTable.area &&
            sentTable.label === selectedTable.label;
          const withinPostSendGrace =
            currentLines.length > 0 &&
            Date.now() - lastSendAtRef.current < 5000 &&
            isSameTable;
          if (withinPostSendGrace) {
            // Don't overwrite with empty — we may have just sent; server may not have synced yet
            return;
          }
          useTicketStore
            .getState()
            .hydrate({ items: [], note: latest?.note || '' });
        }
      } catch (e) {
        void e;
      }
    })();
  }, [
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
    ticketSyncing,
  ]);

  // If an open table's ticket becomes empty due to voids, free the table (turn green) after server check.
  // Skip while ticketSyncing is active — the void flow handles the re-sync itself.
  useEffect(() => {
    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      return;
    }
    if (ticketSyncing) return;
    if (!selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (lines.length === 0) {
      if (suppressFreeOnEmptyRef.current) return;
      const gen = hydrateGenRef.current;
      (async () => {
        try {
          const latest = await window.api.tickets.getLatestForTable(
            selectedTable.area,
            selectedTable.label,
          );
          if (gen !== hydrateGenRef.current) return;
          const items = Array.isArray(latest?.items) ? latest!.items : [];
          const remaining = items.filter((it: any) => !it.voided);
          if (remaining.length) {
            // Rehydrate and keep table open
            useTicketStore
              .getState()
              .hydrate({ items: remaining as any, note: latest?.note || '' });
            setOpen(selectedTable.area, selectedTable.label, true);
            return;
          }
        } catch (e) {
          void e;
        }
        if (gen !== hydrateGenRef.current) return;
        setOpen(selectedTable.area, selectedTable.label, false);
        window.api.tables
          .setOpen(selectedTable.area, selectedTable.label, false)
          .catch(() => {});
      })();
    }
  }, [lines.length, selectedTable, ticketSyncing]);

  // Menu is managed by the business admin (no remote syncing).

  // Owner: poll for approved requests for current table and apply to ticket.
  // Uses an `alive` flag so async work that resolves after unmount/cleanup
  // does not mutate the ticket store, and reschedules only while alive.
  useEffect(() => {
    if (!user || !selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (ownerId == null || Number(ownerId) !== Number(user.id)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const rows = await window.api.requests.pollApprovedForTable(
          user.id,
          selectedTable.area,
          selectedTable.label,
        );
        if (!alive) return;
        if (Array.isArray(rows) && rows.length) {
          for (const r of rows) {
            const items = Array.isArray(r.items) ? r.items : [];
            for (const it of items) {
              addItem({
                sku: String(it.name),
                name: String(it.name),
                unitPrice: Number(it.unitPrice || 0),
                vatRate: Number(it.vatRate || 0),
              });
              const times = Math.max(1, Number(it.qty || 1)) - 1;
              for (let i = 0; i < times; i++) {
                const last = useTicketStore.getState().lines.slice(-1)[0];
                if (last) useTicketStore.getState().increment(last.id);
              }
            }
          }
          await window.api.requests
            .markApplied(rows.map((r: any) => r.id))
            .catch(() => {});
        }
      } finally {
        if (alive) timer = setTimeout(tick, 4000);
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [user?.id, selectedTable?.area, selectedTable?.label, ownerId]);

  const shouldBlockForLoading =
    !openLoaded ||
    (openLoaded && Boolean(selectedTable) && isTableOpen && !ticketLoaded);

  if (shouldBlockForLoading) {
    return (
      <PageSpinner
        message={
          openLoadError
            ? t(`order.loadErrors.${openLoadError}`)
            : !openLoaded
              ? t('order.loadingTables')
              : t('order.loadingTicket')
        }
      />
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col md:grid md:grid-cols-3 md:gap-4 gap-3">
      {/* Mobile: switch between Menu and Ticket to avoid cramped 3-column layout */}
      <div className="md:hidden pos-surface-panel p-2 flex items-center gap-2">
        <button
          className="pos-icon-btn shrink-0 cursor-pointer text-gray-100"
          onClick={() => navigate('/app/tables')}
          type="button"
          aria-label={t('order.backToTables')}
          title={t('order.backToTables')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            className="pos-icon"
            aria-hidden="true"
          >
            <path
              d="M15 6l-6 6 6 6"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors duration-150 ${mobilePane === 'menu' ? 'bg-emerald-700 text-white' : 'bg-gray-700/90 text-gray-100 hover:bg-gray-600'}`}
          onClick={() => setMobilePane('menu')}
          type="button"
        >
          {t('order.menu')}
        </button>
        <button
          className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors duration-150 ${mobilePane === 'ticket' ? 'bg-emerald-700 text-white' : 'bg-gray-700/90 text-gray-100 hover:bg-gray-600'}`}
          onClick={() => setMobilePane('ticket')}
          type="button"
        >
          {lines.length
            ? t('order.ticketCount', { count: lines.length })
            : t('order.ticket')}
        </button>
      </div>

      <div
        className={`md:col-span-2 min-h-0 overflow-auto ${mobilePane === 'menu' ? 'flex-1' : 'hidden'} md:block`}
      >
        <div className="flex gap-2 mb-3">
          <input
            placeholder={t('order.searchMenu')}
            className="w-full rounded-lg bg-gray-700 p-2 transition-colors placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/50"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
          {/* Favourites tab */}
          <button
            key={-1}
            onClick={() => setSelectedCatId(-1)}
            className={`py-4 sm:py-7 px-2 border border-gray-700 hover:bg-gray-800 cursor-pointer rounded ${selected?.id === -1 ? 'bg-gray-800' : 'bg-gray-900'}`}
          >
            {t('order.favourites')}
          </button>
          {categories.map((c) => {
            const tabColor = c.color || null;
            const isActive = selected?.id === c.id;
            // Tabs stay dark even when active so the category color
            // doesn't dominate the chrome — instead we render a small
            // dot + a thin coloured stripe along the bottom edge as a
            // legend. The actual tiles below get the full colour
            // treatment so the connection between "this category" and
            // "those items" is obvious.
            return (
              <button
                key={c.id}
                onClick={() => setSelectedCatId(c.id)}
                className={`relative py-4 sm:py-7 px-2 border border-gray-700 hover:bg-gray-800 cursor-pointer rounded overflow-hidden ${
                  isActive ? 'bg-gray-800' : 'bg-gray-900'
                }`}
                style={
                  tabColor
                    ? {
                        boxShadow: isActive
                          ? `inset 0 -3px 0 0 ${tabColor}`
                          : `inset 0 -2px 0 0 ${tabColor}80`,
                      }
                    : undefined
                }
              >
                <span className="inline-flex items-center gap-2">
                  {tabColor ? (
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: tabColor }}
                      aria-hidden
                    />
                  ) : null}
                  {c.name}
                </span>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {filteredItems.map((i: MenuItemDTO) => {
            const isFav = fav.isFav(user?.id || null, i.sku);
            const isDisabled = (i as any)?.active === false;
            // Inherit the parent category's colour so the floor sees
            // food and drinks as instantly distinguishable blocks.
            // Disabled items override the colour with a neutral grey
            // — a "this is unavailable" signal beats any branding.
            const tileBg =
              categoryColorById.get(Number(i.categoryId)) || FALLBACK_TILE_BG;
            const textColor = readableTextColor(tileBg);
            return (
              <div key={i.id} className="relative">
                <button
                  className={`py-4 rounded text-left px-3 w-full transition-opacity ${
                    isDisabled
                      ? 'bg-gray-800/60 border border-gray-700 text-gray-400 cursor-not-allowed'
                      : 'cursor-pointer hover:opacity-90'
                  }`}
                  style={
                    isDisabled
                      ? undefined
                      : { backgroundColor: tileBg, color: textColor }
                  }
                  disabled={isDisabled || ticketSyncing || busyAction != null}
                  onClick={() => {
                    if (isDisabled || ticketSyncing || busyAction != null)
                      return;
                    // If isKg, open weight keypad; otherwise add normally
                    const isKg =
                      Boolean((i as any)?.isKg) ||
                      Boolean((i as any)?.tags?.isKg);
                    if (isKg) {
                      setWeightModal({
                        sku: i.sku,
                        name: i.name,
                        unitPrice: i.price,
                        vatRate: i.vatRate,
                        station: i.station,
                        categoryId: i.categoryId,
                        categoryName:
                          categoryNameById.get(Number(i.categoryId)) ||
                          undefined,
                      } as any);
                      setWeightInput('');
                    } else {
                      addItem({
                        sku: i.sku,
                        name: i.name,
                        unitPrice: i.price,
                        vatRate: i.vatRate,
                        station: i.station,
                        categoryId: i.categoryId,
                        categoryName:
                          categoryNameById.get(Number(i.categoryId)) ||
                          undefined,
                      } as any);
                    }
                  }}
                >
                  <div
                    className={`font-medium pr-6 ${isDisabled ? 'line-through' : ''}`}
                  >
                    {i.name}
                  </div>
                  <div className="text-sm">{i.price}</div>
                </button>
                <button
                  // Translucent black backdrop so the heart stays
                  // legible on top of any category colour (used to be
                  // hard-coded pink/emerald and looked awful on a red
                  // drinks tile).
                  className={`absolute top-1 right-1 text-xs px-2 py-1 rounded cursor-pointer backdrop-blur-sm bg-black/30 hover:bg-black/50 ${
                    isFav ? 'text-pink-300' : 'text-white/90'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (user?.id) fav.toggle(user.id, i.sku);
                  }}
                  title={
                    isFav
                      ? t('order.favouriteRemoveTitle')
                      : t('order.favouriteAddTitle')
                  }
                >
                  {isFav ? '♥' : '♡'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className={`bg-gray-800 p-3 rounded flex flex-col min-h-0 h-full ${mobilePane === 'ticket' ? 'flex-1' : 'hidden'} md:flex`}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold flex items-center gap-2">
            <span>
              {selectedTable
                ? t('order.ticketHeader', { label: selectedTable.label })
                : t('order.ticket')}
            </span>
            {selectedTable &&
              isOpen(selectedTable.area, selectedTable.label) &&
              openedAtMs && (
                <span className="text-xs font-mono px-2 py-1 rounded bg-gray-700/60 border border-gray-600">
                  {formatElapsed(nowMs - openedAtMs)}
                </span>
              )}
          </div>
          <div className="flex items-center gap-2">
            {canTransfer && (
              <button
                type="button"
                className="bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded border border-indigo-500 text-sm"
                onClick={() => setShowTransfer(true)}
                title={t('order.transferTitle')}
              >
                {t('order.transfer')}
              </button>
            )}
            {selectedTable &&
              isOpen(selectedTable.area, selectedTable.label) && (
                <button
                  type="button"
                  className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded border border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-gray-700"
                  onClick={() => {
                    if (!canEditCovers) return;
                    setCoversMode('editOnly');
                    setCoversValue(
                      typeof coversKnown === 'number'
                        ? String(coversKnown)
                        : '',
                    );
                    setShowCovers(true);
                  }}
                  disabled={!canEditCovers}
                  title={
                    canEditCovers
                      ? t('order.editCovers')
                      : t('order.editCoversBlocked')
                  }
                  aria-label={
                    canEditCovers
                      ? t('order.editCovers')
                      : t('order.editCoversAriaBlocked')
                  }
                >
                  <ForkKnifeIcon />
                  <span className="text-sm font-semibold">
                    {typeof coversKnown === 'number' ? coversKnown : '—'}
                  </span>
                </button>
              )}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto relative">
          {(ticketSyncing || busyAction != null) && (
            <PageSpinner
              variant="overlay"
              message={
                ticketSyncing
                  ? t('order.syncingTicket')
                  : busyAction === 'send'
                    ? t('order.sendingOrder')
                    : busyAction === 'void'
                      ? t('order.voiding')
                      : busyAction === 'pay'
                        ? t('order.processingPayment')
                        : t('order.pleaseWait')
              }
            />
          )}
          <div className="space-y-2">
            {lines.length === 0 ? (
              <div className="text-sm opacity-60">{t('order.selectItems')}</div>
            ) : (
              lines.map((l) => {
                const showRequestOnly = Boolean(
                  selectedTable &&
                    isOpen(selectedTable.area, selectedTable.label) &&
                    ownerId &&
                    user?.id != null &&
                    Number(ownerId) !== Number(user.id),
                );
                const isTableOpen = Boolean(
                  selectedTable &&
                    isOpen(selectedTable.area, selectedTable.label),
                );
                const dimmed = isTableOpen && !l.staged; // darker when already sent
                return (
                  <div key={l.id} className="bg-gray-700 rounded px-2 py-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <div
                          className={`${dimmed ? 'text-gray-400' : 'text-white'} font-medium`}
                        >
                          {l.name}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {selectedTable &&
                        isOpen(selectedTable.area, selectedTable.label) &&
                        !showRequestOnly &&
                        l.staged ? (
                          <>
                            <button
                              className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                              style={{
                                width: '28px',
                                height: '28px',
                                minWidth: '28px',
                                minHeight: '28px',
                                padding: 0,
                              }}
                              onClick={() => decrement(l.id)}
                              disabled={l.qty === 1}
                            >
                              -
                            </button>
                            <div className="w-6 text-center">{l.qty}</div>
                            <button
                              className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                              style={{
                                width: '28px',
                                height: '28px',
                                minWidth: '28px',
                                minHeight: '28px',
                                padding: 0,
                              }}
                              onClick={() => increment(l.id)}
                              disabled={l.qty >= 100}
                            >
                              +
                            </button>
                          </>
                        ) : (
                          <div className="w-6 text-center text-gray-400">
                            {t('common.qty')}:{l.qty}
                          </div>
                        )}
                        <div
                          className={`w-20 text-right ${dimmed ? 'text-gray-400' : 'text-white'}`}
                        >
                          {l.unitPrice * l.qty}
                        </div>
                        {/* When table is open (sent), owner can void already-sent lines; staged (unsent) lines can be removed */}
                        {selectedTable && isTableOpen && !showRequestOnly ? (
                          l.staged ? (
                            <button
                              className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                              style={{
                                width: '28px',
                                height: '28px',
                                minWidth: '28px',
                                minHeight: '28px',
                                padding: 0,
                              }}
                              onClick={() => removeLine(l.id)}
                            >
                              X
                            </button>
                          ) : (
                            <button
                              className="bg-red-700 hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                              style={{
                                width: '28px',
                                height: '28px',
                                minWidth: '28px',
                                minHeight: '28px',
                                padding: 0,
                              }}
                              onClick={() =>
                                setVoidTarget({
                                  id: l.id,
                                  name: l.name,
                                  qty: l.qty,
                                  unitPrice: l.unitPrice,
                                  vatRate: l.vatRate,
                                  note: l.note,
                                })
                              }
                              title={t('order.voidTitle')}
                            >
                              A
                            </button>
                          )
                        ) : (
                          // For non-owners or not-open tables: allow removing; if in request-only mode, only staged lines are allowed
                          <button
                            className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                            style={{
                              width: '28px',
                              height: '28px',
                              minWidth: '28px',
                              minHeight: '28px',
                              padding: 0,
                            }}
                            disabled={showRequestOnly && !l.staged}
                            onClick={() => removeLine(l.id)}
                          >
                            X
                          </button>
                        )}
                      </div>
                    </div>
                    <input
                      className={`mt-2 w-full rounded px-2 py-1 text-sm placeholder:text-gray-300 ${dimmed && !(showRequestOnly && l.staged) ? 'bg-gray-700 opacity-60 cursor-not-allowed' : 'bg-gray-600'}`}
                      placeholder={t('order.lineNotePlaceholder')}
                      value={l.note ?? ''}
                      disabled={Boolean(
                        dimmed && !(showRequestOnly && l.staged),
                      )}
                      onChange={(e) => setLineNote(l.id, e.target.value)}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer pinned at the bottom of the ticket panel as a flex child.
            Was previously `absolute bottom-0` with `pb-80` on the items list,
            which overlapped the last item on narrow viewports. */}
        <div className="shrink-0 mt-3 bg-gray-800 border-t border-gray-700 -mx-3 -mb-3 p-3 rounded-b">
          <div className="space-y-3 text-sm">
            <div>
              <label className="block text-xs mb-1 opacity-70">
                {t('order.orderNotes')}
              </label>
              {(() => {
                const requestOnly = Boolean(
                  selectedTable &&
                    isOpen(selectedTable.area, selectedTable.label) &&
                    ownerId &&
                    user?.id != null &&
                    Number(ownerId) !== Number(user.id),
                );
                const ticketOpen = Boolean(
                  selectedTable &&
                    isOpen(selectedTable.area, selectedTable.label),
                );
                // Disable order note both when ticket is open and in request-only mode; notes should only be on staged items
                const disabled = ticketOpen || requestOnly;
                return (
                  <textarea
                    className={`w-full rounded px-2 py-2 text-sm ${disabled ? 'bg-gray-700 opacity-60 cursor-not-allowed' : 'bg-gray-700'}`}
                    rows={2}
                    placeholder={t('order.orderNotesPlaceholder')}
                    value={orderNote}
                    disabled={disabled}
                    onChange={(e) => setOrderNote(e.target.value)}
                  />
                );
              })()}
            </div>

            <TicketTotals
              totals={totals}
              vatEnabled={vatEnabled}
              serviceChargeCfg={serviceChargeCfg}
              applyServiceCharge={applyServiceCharge}
              serviceChargeAmount={serviceChargeAmount}
            />

            <div className="flex gap-2">
              {(() => {
                const showRequestOnly = Boolean(
                  selectedTable &&
                    isOpen(selectedTable.area, selectedTable.label) &&
                    ownerId &&
                    user?.id != null &&
                    Number(ownerId) !== Number(user.id),
                );
                if (showRequestOnly) {
                  const stagedCount = lines.filter((l) => l.staged).length;
                  return (
                    <button
                      className="flex-1 bg-amber-700 hover:bg-amber-600 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                      disabled={
                        stagedCount === 0 ||
                        requestLocked ||
                        busyAction != null ||
                        !connectionOk
                      }
                      onClick={async () => {
                        if (busyAction != null) return;
                        if (!selectedTable || !user?.id || !ownerId) return;
                        const staged = lines.filter((l) => l.staged);
                        if (staged.length === 0) {
                          toast.warn(t('order.requestAddBefore'));
                          return;
                        }
                        if (!connectionOk) {
                          toast.warn(t('order.networkSlow'));
                          return;
                        }
                        setBusyAction('request');
                        // IMPORTANT: only request staged items (newly added), not the whole existing ticket.
                        const items = staged.map((l) => ({
                          sku: l.sku,
                          name: l.name,
                          qty: l.qty,
                          unitPrice: l.unitPrice,
                          vatRate: l.vatRate,
                          note: l.note,
                        }));
                        try {
                          await window.api.requests.create({
                            requesterId: user.id,
                            ownerId,
                            area: selectedTable.area,
                            tableLabel: selectedTable.label,
                            items,
                            note: null,
                          });
                          setRequestLocked(true);
                          toast.success(t('order.requestSent'));
                        } catch {
                          toast.error(t('order.requestFailed'));
                        } finally {
                          setBusyAction(null);
                        }
                      }}
                      type="button"
                    >
                      {busyAction === 'request'
                        ? t('order.sending')
                        : t('order.requestAddItems')}
                    </button>
                  );
                }
                return (
                  <>
                    <button
                      className="flex-1 bg-red-600 hover:bg-red-700 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                      disabled={
                        lines.length === 0 ||
                        busyAction != null ||
                        !connectionOk ||
                        ticketSyncing
                      }
                      onClick={async () => {
                        if (busyAction != null || ticketSyncing) return;
                        if (!connectionOk) {
                          toast.warn(t('order.networkSlow'));
                          return;
                        }
                        setBusyAction('void');
                        try {
                          if (
                            selectedTable &&
                            isOpen(selectedTable.area, selectedTable.label)
                          ) {
                            if (!user?.id) return;
                            let approvedByAdmin: {
                              userId: number;
                              userName: string;
                              approvalToken?: string;
                            } | null = null;
                            if (approvalsCfg.requireManagerPinForVoid) {
                              const approved = await requestAdminApproval(
                                t('order.approvalVoidTicket'),
                              );
                              if (!approved) return;
                              approvedByAdmin = approved;
                            }
                            // Optimistic UI: immediately clear and mark table as free locally.
                            setOpen(
                              selectedTable.area,
                              selectedTable.label,
                              false,
                            );
                            clear();
                            setOrderNote('');

                            // PR 4a: voidTicket + the table-close
                            // sidecar both go through the queue.
                            // Without this, voiding a ticket on a
                            // flaky network meant the table stayed
                            // "open" forever and the void was lost.
                            await tryOrQueue('tickets.voidTicket', {
                              userId: user.id,
                              area: selectedTable.area,
                              tableLabel: selectedTable.label,
                              reason: orderNote || undefined,
                              actorRole: user.role,
                              ...(approvedByAdmin
                                ? {
                                    approvedByAdminId: approvedByAdmin.userId,
                                    approvedByAdminName:
                                      approvedByAdmin.userName,
                                    approvedByAdminToken:
                                      approvedByAdmin.approvalToken,
                                  }
                                : {}),
                            });
                            // Persist free table server-side too
                            // (otherwise TablesPage refresh will
                            // re-mark it open). Dedupe so a chain of
                            // void/close clicks coalesces to one
                            // eventual write.
                            await tryOrQueue(
                              'tables.setOpen',
                              {
                                area: selectedTable.area,
                                label: selectedTable.label,
                                open: false,
                              },
                              {
                                dedupeKey: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                              },
                            ).catch(() => {});
                          }
                          // When table isn't open, void button acts as "clear"
                          if (
                            !selectedTable ||
                            !isOpen(selectedTable.area, selectedTable.label)
                          ) {
                            clear();
                            setOrderNote('');
                          }
                        } catch {
                          toast.error(t('order.voidClearFailed'));
                        } finally {
                          setBusyAction(null);
                        }
                      }}
                      type="button"
                    >
                      {busyAction === 'void'
                        ? t('order.voidingBtn')
                        : selectedTable &&
                            isOpen(selectedTable.area, selectedTable.label)
                          ? t('order.voidTicket')
                          : t('order.clear')}
                    </button>
                    <button
                      className="flex-1 bg-blue-600 hover:bg-blue-700 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                      disabled={
                        lines.length === 0 ||
                        busyAction != null ||
                        !connectionOk ||
                        ticketSyncing
                      }
                      onClick={async () => {
                        if (busyAction != null || ticketSyncing) return;
                        if (!selectedTable) {
                          setPendingAction('send');
                          navigate('/app/tables');
                          return;
                        }
                        // Ask for covers only if table is not marked as open (green)
                        if (!isOpen(selectedTable.area, selectedTable.label)) {
                          setCoversMode('openAndSend');
                          setCoversValue('');
                          setShowCovers(true);
                          return;
                        }
                        if (!connectionOk) {
                          toast.warn(t('order.networkSlow'));
                          return;
                        }
                        // Enrich log with details (table, order lines, notes, covers)
                        lastSendAtRef.current = Date.now();
                        lastSendTableRef.current = {
                          area: selectedTable.area,
                          label: selectedTable.label,
                        };
                        setBusyAction('send');
                        try {
                          const lastCovers = await window.api.covers.getLast(
                            selectedTable.area,
                            selectedTable.label,
                          );
                          const stagedOnly = lines.filter((l) => l.staged);
                          const isFireOrder = stagedOnly.length > 0;
                          const details = {
                            table: selectedTable.label,
                            area: selectedTable.area,
                            covers: lastCovers ?? null,
                            orderNote,
                            lines: lines.map((l) => ({
                              sku: l.sku,
                              name: l.name,
                              qty: l.qty,
                              unitPrice: l.unitPrice,
                              vatRate: l.vatRate,
                              note: l.note,
                              station: (l as any).station,
                              categoryId: (l as any).categoryId,
                              categoryName: (l as any).categoryName,
                            })),
                          };
                          const printLines = isFireOrder
                            ? stagedOnly.map((l) => ({
                                sku: l.sku,
                                name: l.name,
                                qty: l.qty,
                                unitPrice: l.unitPrice,
                                vatRate: l.vatRate,
                                note: l.note,
                                station: (l as any).station,
                                categoryId: (l as any).categoryId,
                                categoryName: (l as any).categoryName,
                              }))
                            : details.lines;
                          // (optional) send log
                          if (!user?.id) return; // require logged-in user to log ticket
                          const logResult = await logTicket({
                            userId: user.id,
                            area: selectedTable.area,
                            tableLabel: selectedTable.label,
                            covers: lastCovers ?? null,
                            items: details.lines,
                            note: orderNote,
                          });
                          if (!logResult.ok) {
                            // Server rejected — most often the table
                            // was closed/paid by another waiter or is
                            // owned by someone else. Don't fire the
                            // print, refresh the open-tables map, and
                            // surface a clean toast.
                            toast.error(logResult.error, {
                              title: t('order.toastSendBlocked'),
                            });
                            try {
                              const open = await window.api.tables.listOpen();
                              if (Array.isArray(open)) {
                                const stillOpen = open.some(
                                  (tbl: any) =>
                                    tbl.area === selectedTable.area &&
                                    tbl.label === selectedTable.label,
                                );
                                setOpen(
                                  selectedTable.area,
                                  selectedTable.label,
                                  stillOpen,
                                );
                              }
                            } catch {
                              // ignore — toast is the source of truth
                            }
                            return;
                          }
                          // Immediately dim and lock qty by marking all as sent (optimistic)
                          useTicketStore.getState().markAllAsSent();
                          await window.api.tickets.print({
                            area: selectedTable.area,
                            tableLabel: selectedTable.label,
                            covers: lastCovers ?? null,
                            items: printLines,
                            note: orderNote,
                            userName: user.displayName,
                            meta: {
                              userId: user.id,
                              // Only routed/split prints should be kind=ORDER. The blue "Print Ticket" (no staged items)
                              // should print the full order as one ticket.
                              kind: isFireOrder ? 'ORDER' : 'TICKET',
                              vatEnabled,
                              serviceChargeEnabled: serviceChargeCfg.enabled,
                              serviceChargeApplied: serviceChargeCfg.enabled,
                              serviceChargeMode: serviceChargeCfg.mode,
                              serviceChargeValue: serviceChargeCfg.value,
                              serviceChargeAmount: serviceChargeCfg.enabled
                                ? serviceChargeCfg.mode === 'PERCENT'
                                  ? Math.max(
                                      0,
                                      (Number(totals.total || 0) *
                                        Number(serviceChargeCfg.value || 0)) /
                                        100,
                                    )
                                  : Math.max(
                                      0,
                                      Number(serviceChargeCfg.value || 0),
                                    )
                                : 0,
                            },
                          });
                          // Mark table open optimistically (server poll merges, but we protect optimistic state for a short TTL)
                          setOpen(
                            selectedTable.area,
                            selectedTable.label,
                            true,
                          );
                          await window.api.tables
                            .setOpen(
                              selectedTable.area,
                              selectedTable.label,
                              true,
                            )
                            .catch(() => {});
                        } catch (e: any) {
                          const raw = String(e?.message || e || '').trim();
                          const m = raw.match(
                            /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
                          );
                          const detail = (m ? m[1] : raw).trim();
                          const status = Number(e?.status || 0);
                          const isAuth = status === 401 || status === 403;
                          const isAbort =
                            String(e?.name || '') === 'AbortError';
                          const isType = e instanceof TypeError;
                          const title = isAuth
                            ? t('order.toastSendBlockedSignedOut')
                            : isAbort
                              ? t('order.toastSendTimedOut')
                              : isType
                                ? t('order.toastCantReachHost')
                                : t('order.toastSendFailed');
                          toast.error(detail || t('order.toastTryAgain'), {
                            title,
                          });
                          if (typeof console !== 'undefined')
                            console.warn('[print/ticket] failed:', e);
                        } finally {
                          setBusyAction(null);
                        }
                      }}
                      type="button"
                    >
                      {busyAction === 'send'
                        ? t('order.sendingOrder')
                        : lines.some((l) => l.staged)
                          ? t('order.sendOrder')
                          : t('order.printTicket')}
                    </button>
                    <button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                      disabled={
                        !canPay ||
                        busyAction != null ||
                        !connectionOk ||
                        ticketSyncing
                      }
                      title={
                        !selectedTable
                          ? t('order.selectTable')
                          : lines.length === 0
                            ? t('order.addItems')
                            : !isTableOpen
                              ? t('order.sendAndGuests')
                              : hasUnsentItems
                                ? t('order.sendBeforePay')
                                : typeof coversKnown !== 'number' ||
                                    coversKnown <= 0
                                  ? t('order.setGuestsBeforePay')
                                  : !connectionOk
                                    ? t('order.networkWaitPay')
                                    : t('order.pay')
                      }
                      onClick={async () => {
                        if (busyAction != null) return;
                        if (!selectedTable) {
                          setPendingAction('pay');
                          navigate('/app/tables');
                          return;
                        }
                        if (!connectionOk) {
                          toast.warn(t('order.networkSlow'));
                          return;
                        }
                        // Open payment modal (choose method + amount + print)
                        setPaymentMethod('CASH');
                        setDiscountType('NONE');
                        setDiscountValue('');
                        setDiscountReason('');
                        const scEnabled = serviceChargeCfg.enabled;
                        setApplyServiceCharge(scEnabled);
                        const base = Number(totals.total || 0);
                        const v = Number(serviceChargeCfg.value || 0);
                        const scAmt = scEnabled
                          ? serviceChargeCfg.mode === 'PERCENT'
                            ? (base * v) / 100
                            : v
                          : 0;
                        setAmountPaid(
                          String(
                            Math.max(
                              0,
                              base + (Number.isFinite(scAmt) ? scAmt : 0),
                            ).toFixed(2),
                          ),
                        );
                        setPrintReceipt(true);
                        setShowPayment(true);
                      }}
                      type="button"
                    >
                      {busyAction === 'pay'
                        ? t('order.paying')
                        : t('order.pay')}
                    </button>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {showPayment && selectedTable && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-3 sm:p-4 overflow-hidden">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full sm:w-[92vw] max-w-6xl p-4 flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] relative">
            <div className="flex items-center justify-between mb-3 shrink-0">
              <div className="text-lg font-semibold">{t('order.payment')}</div>
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={busyAction === 'pay'}
                onClick={() => setShowPayment(false)}
              >
                {t('common.close')}
              </button>
            </div>
            {busyAction === 'pay' && (
              <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm rounded-xl flex flex-col items-center justify-center gap-3 z-10"
                role="status"
                aria-live="polite"
              >
                <span
                  className="inline-block w-10 h-10 border-4 border-white/20 border-t-emerald-400 rounded-full animate-spin"
                  aria-hidden
                />
                <div className="text-base font-medium">
                  {t('order.processingPaymentOverlay')}
                </div>
                <div className="text-xs opacity-70">
                  {t('order.recordingPayment')}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
              {/* Order summary */}
              <div className="bg-gray-800 rounded-lg p-3 min-h-[280px] flex flex-col">
                <div className="text-sm opacity-80 mb-2">
                  {t('order.orderSummary')}
                </div>
                <div className="text-xs opacity-60 mb-2">
                  {t('order.selectGuestsPayment')}
                </div>
                <div className="flex gap-2 mb-3">
                  <button
                    className="flex-1 bg-gray-700 rounded py-2 text-sm opacity-70"
                    disabled
                  >
                    {t('common.covers')}
                  </button>
                </div>
                <div className="flex-1 overflow-auto space-y-2">
                  <div className="bg-gray-700/60 rounded p-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">
                        {t('common.table')} {selectedTable.label}
                      </div>
                      <div className="text-xs opacity-70">
                        {t('common.coversWithVal', {
                          val:
                            typeof coversKnown === 'number' ? coversKnown : '—',
                        })}
                      </div>
                    </div>
                    <div className="text-sm font-semibold">
                      {formatAmount(totals.total)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 text-sm opacity-80 flex justify-between">
                  <span>{t('common.total')}</span>
                  <span className="font-semibold">
                    {formatAmount(totals.total)}
                  </span>
                </div>
              </div>

              {/* Payment methods */}
              <div className="bg-gray-800 rounded-lg p-3 min-h-[280px]">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm opacity-80">
                    {t('order.paymentMethods')}
                  </div>
                </div>
                <div className="space-y-2">
                  <PayMethodButton
                    active={paymentMethod === 'CASH'}
                    onClick={() => setPaymentMethod('CASH')}
                    label={t('order.cash')}
                  >
                    <IconCash />
                  </PayMethodButton>
                  <div className="text-xs opacity-60 mt-3">
                    {t('order.cards')}
                  </div>
                  <PayMethodButton
                    active={paymentMethod === 'CARD'}
                    onClick={() => setPaymentMethod('CARD')}
                    label={t('order.card')}
                  >
                    <IconCard />
                  </PayMethodButton>
                  {/* <div className="text-xs opacity-60 mt-3">Other</div>
                  <PayMethodButton active={paymentMethod === 'GIFT_CARD'} onClick={() => setPaymentMethod('GIFT_CARD')} label="Gift Card">
                    <IconGift />
                  </PayMethodButton> */}
                </div>
              </div>

              {/* Amount & confirm */}
              <div className="bg-gray-800 rounded-lg p-3 min-h-[280px] flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm opacity-80 flex items-center gap-2">
                    <IconReceipt />
                    {t('order.paymentAmount')}
                  </div>
                  <div className="text-sm font-semibold">
                    {formatAmount(totalDue)}
                  </div>
                </div>
                {/* <button
                  className="bg-blue-600 hover:bg-blue-700 rounded py-4 font-semibold"
                  onClick={() => {
                    // quick set "amount paid" to total
                    setAmountPaid(String(totals.total.toFixed(2)));
                  }}
                >
                  Amount paid
                </button> */}
                <div className="mt-3">
                  {/* <input
                    className="w-full bg-gray-700 rounded px-3 py-2"
                    placeholder="Enter amount paid"
                    value={amountPaid}
                    onChange={(e) => setAmountPaid(e.target.value)}
                  /> */}
                  {/* {paymentMethod === 'CASH' && (() => {
                    const paid = Number(amountPaid);
                    const change = Number.isFinite(paid) ? Math.max(0, paid - totalDue) : 0;
                    return (
                      <div className="text-xs opacity-70 mt-2">
                        Change: <span className="font-semibold">{formatAmount(change)}</span>
                      </div>
                    );
                  })()} */}
                </div>
                {serviceChargeCfg.enabled && (
                  <div className="mt-3 p-3 rounded bg-gray-900/40 border border-gray-700">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium">
                        {t('common.serviceCharge')}
                      </div>
                      <div className="text-xs opacity-70">
                        {applyServiceCharge && serviceChargeAmount > 0
                          ? `+ ${formatAmount(serviceChargeAmount)}`
                          : '—'}
                      </div>
                    </div>
                    <label className="flex items-center justify-between gap-3">
                      <div className="text-sm opacity-80">
                        {t('order.applyServiceCharge')}
                      </div>
                      <input
                        type="checkbox"
                        checked={applyServiceCharge}
                        onChange={(e) =>
                          setApplyServiceCharge(e.target.checked)
                        }
                      />
                    </label>
                    <div className="text-xs opacity-70 mt-2">
                      {t('order.config')}:{' '}
                      {serviceChargeCfg.mode === 'PERCENT'
                        ? `${serviceChargeCfg.value}%`
                        : `${serviceChargeCfg.value}`}
                    </div>
                  </div>
                )}
                <div className="mt-3 p-3 rounded bg-gray-900/40 border border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-medium">
                      {t('common.discount')}
                    </div>
                    <div className="text-xs opacity-70">
                      {discountAmount > 0
                        ? `- ${formatAmount(discountAmount)}`
                        : '—'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      type="button"
                      className={`px-3 py-2 rounded text-sm ${discountType === 'PERCENT' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                      onClick={() => setDiscountType('PERCENT')}
                    >
                      %
                    </button>
                    <button
                      type="button"
                      className={`px-3 py-2 rounded text-sm ${discountType === 'AMOUNT' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                      onClick={() => setDiscountType('AMOUNT')}
                    >
                      €
                    </button>
                    {/* <button
                      type="button"
                      className={`px-3 py-2 rounded text-sm ${discountType === 'NONE' ? 'bg-gray-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                      onClick={() => { setDiscountType('NONE'); setDiscountValue(''); }}
                    >
                      C
                    </button> */}
                    <input
                      className="flex-1 bg-gray-700 rounded px-3 py-2 text-sm"
                      placeholder={
                        discountType === 'PERCENT'
                          ? t('order.discountPlaceholderPercent')
                          : discountType === 'AMOUNT'
                            ? t('order.discountPlaceholderAmount')
                            : t('order.discountPlaceholderType')
                      }
                      value={discountValue}
                      disabled={discountType === 'NONE'}
                      onChange={(e) => setDiscountValue(e.target.value)}
                    />
                  </div>
                  <input
                    className="w-full bg-gray-700 rounded px-2 py-2 text-sm"
                    placeholder={t('order.discountReason')}
                    value={discountReason}
                    onChange={(e) => setDiscountReason(e.target.value)}
                  />
                  {discountAmount > 0 && (
                    <div className="text-xs opacity-70 mt-2 flex items-center justify-between">
                      <span>{t('order.totalAfterDiscount')}</span>
                      <span className="font-semibold">
                        {formatAmount(totalDue)}
                      </span>
                    </div>
                  )}
                </div>
                <div className="mt-auto pt-3">
                  {(() => {
                    const needsDiscountApproval =
                      approvalsCfg.requireManagerPinForDiscount &&
                      discountAmount > 0;
                    const needsServiceRemovalApproval =
                      approvalsCfg.requireManagerPinForServiceChargeRemoval &&
                      serviceChargeCfg.enabled &&
                      serviceChargeConfiguredAmount > 0 &&
                      !applyServiceCharge;
                    if (!needsDiscountApproval && !needsServiceRemovalApproval)
                      return null;
                    return (
                      <div className="mb-2 text-xs text-amber-200 opacity-90">
                        {t('order.managerPinPayment')}
                      </div>
                    );
                  })()}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <IconPrinter />
                      <span className="text-sm">{t('order.printReceipt')}</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={printReceipt}
                      className={`relative h-8 w-14 shrink-0 rounded-full transition-colors duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
                        printReceipt ? 'bg-blue-600' : 'bg-gray-700'
                      }`}
                      onClick={() => setPrintReceipt((v) => !v)}
                      aria-label={t('order.togglePrintReceipt')}
                    >
                      <span
                        aria-hidden
                        className={`pointer-events-none absolute top-1/2 size-[1.375rem] -translate-y-1/2 rounded-full bg-white shadow-md ring-1 ring-black/15 transition-[left] duration-200 ease-out ${
                          printReceipt
                            ? 'left-[calc(100%-1.375rem-5px)]'
                            : 'left-[5px]'
                        }`}
                      />
                    </button>
                  </div>
                  <button
                    className="w-full bg-emerald-700 hover:bg-emerald-800 disabled:bg-emerald-700/60 disabled:cursor-not-allowed rounded py-4 font-semibold flex items-center justify-center gap-2"
                    disabled={busyAction != null || !connectionOk}
                    onClick={async () => {
                      if (busyAction != null) return;
                      if (!connectionOk) return;
                      setBusyAction('pay');
                      // Track whether we ever got far enough to need to
                      // close the table — keeps "manager approval
                      // cancelled" from triggering a stray close.
                      let attemptedPayment = false;
                      try {
                        const needsDiscountApproval =
                          approvalsCfg.requireManagerPinForDiscount &&
                          discountAmount > 0;
                        const needsServiceRemovalApproval =
                          approvalsCfg.requireManagerPinForServiceChargeRemoval &&
                          serviceChargeCfg.enabled &&
                          serviceChargeConfiguredAmount > 0 &&
                          !applyServiceCharge;
                        let managerApprovedBy: {
                          userId: number;
                          userName: string;
                        } | null = null;
                        if (
                          needsDiscountApproval ||
                          needsServiceRemovalApproval
                        ) {
                          managerApprovedBy = await requestManagerApproval(
                            needsDiscountApproval && needsServiceRemovalApproval
                              ? t('order.approveDiscountAndSc')
                              : needsDiscountApproval
                                ? t('order.approveDiscount')
                                : t('order.approveScRemoval'),
                          );
                          if (!managerApprovedBy) return;
                        }
                        // Payment receipt snapshot (printed or record-only for reports/history)
                        const lastCovers = await window.api.covers
                          .getLast(selectedTable.area, selectedTable.label)
                          .catch(() => null);
                        const items = lines.map((l) => ({
                          sku: l.sku,
                          name: l.name,
                          qty: l.qty,
                          unitPrice: l.unitPrice,
                          vatRate: l.vatRate,
                          note: l.note,
                          station: (l as any).station,
                          categoryId: (l as any).categoryId,
                          categoryName: (l as any).categoryName,
                        }));
                        attemptedPayment = true;
                        const paymentIdempotencyKey =
                          typeof globalThis.crypto !== 'undefined' &&
                          typeof globalThis.crypto.randomUUID === 'function'
                            ? globalThis.crypto.randomUUID()
                            : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
                        // Process the payment + receipt synchronously so
                        // the user sees a real "Processing…" state. The
                        // IPC handler `tickets:print` is bounded:
                        //   - On success it returns once the printer
                        //     ACKs (sub-second).
                        //   - On a transient failure (printer offline,
                        //     ECONNREFUSED, EHOSTDOWN, …) it persists
                        //     the receipt into the PR-3 retry queue and
                        //     returns within the connect timeout
                        //     (PRINTER_TIMEOUT_MS, default 5 s). The
                        //     printer-station loop keeps trying for
                        //     ~4 min after that.
                        //   - On a permanent failure (no printer
                        //     configured, etc.) it returns false; the
                        //     receipt snapshot still lands in PrintJob
                        //     for the audit trail.
                        // Either way the await resolves quickly and the
                        // table close below ALWAYS runs.
                        try {
                          await tryOrQueue('payments.record', {
                            area: selectedTable.area,
                            tableLabel: selectedTable.label,
                            covers: lastCovers ?? null,
                            items,
                            note: orderNote || null,
                            userName: user?.displayName || undefined,
                            recordOnly: !printReceipt,
                            idempotencyKey: paymentIdempotencyKey,
                            meta: {
                              kind: 'PAYMENT',
                              userId: user?.id ?? null,
                              method: paymentMethod,
                              paidAt: new Date().toISOString(),
                              amountPaid: Number(amountPaid),
                              vatEnabled,
                              baseTotal: totals.total,
                              serviceChargeEnabled: serviceChargeCfg.enabled,
                              serviceChargeApplied: serviceChargeCfg.enabled
                                ? applyServiceCharge
                                : false,
                              serviceChargeMode: serviceChargeCfg.mode,
                              serviceChargeValue: serviceChargeCfg.value,
                              serviceChargeAmount,
                              totalBefore: totalBeforeDiscount,
                              discountType,
                              discountValue:
                                discountType === 'NONE'
                                  ? null
                                  : Number(
                                      String(discountValue || '').replace(
                                        ',',
                                        '.',
                                      ),
                                    ),
                              discountAmount,
                              discountReason:
                                (discountReason || '').trim() || null,
                              totalAfter: totalDue,
                              managerApprovedById:
                                managerApprovedBy?.userId ?? null,
                              managerApprovedByName:
                                managerApprovedBy?.userName ?? null,
                            },
                          });
                        } catch {
                          // Swallow — printer-event broadcasts surface
                          // the error toast, and the receipt is either
                          // already in the retry queue (transient) or
                          // recorded in PrintJob (permanent). Don't let
                          // a printer hiccup block the table close.
                        }
                      } finally {
                        // ALWAYS close the table after a real payment
                        // attempt, regardless of print outcome. The
                        // payment record + retry queue have already
                        // captured the money and the receipt; the
                        // table must not stay locked because the
                        // printer is offline.
                        if (attemptedPayment) {
                          setOpen(
                            selectedTable.area,
                            selectedTable.label,
                            false,
                          );
                          try {
                            await tryOrQueue(
                              'tables.setOpen',
                              {
                                area: selectedTable.area,
                                label: selectedTable.label,
                                open: false,
                              },
                              {
                                dedupeKey: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                              },
                            );
                          } catch {
                            // queued or transient — loop will replay
                          }
                          clear();
                          setOrderNote('');
                          setShowPayment(false);
                        }
                        setBusyAction(null);
                      }
                    }}
                  >
                    {busyAction === 'pay' ? (
                      <>
                        <span
                          className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"
                          aria-hidden
                        />
                        <span>{t('order.processingPaymentOverlay')}</span>
                      </>
                    ) : (
                      <span>
                        {t('order.payWithTotal', {
                          amount: formatAmount(totalDue),
                        })}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showTransfer && selectedTable && user?.id && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-[92vw] max-w-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold">
                {t('order.transferTable')}
              </div>
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setShowTransfer(false)}
              >
                {t('common.close')}
              </button>
            </div>

            <div className="text-sm opacity-80 mb-3">
              {t('order.from')}:{' '}
              <b>
                {selectedTable.area} {selectedTable.label}
              </b>
            </div>

            <div className="flex gap-2 mb-4">
              <button
                className={`flex-1 py-2 rounded ${transferMode === 'WAITER' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                onClick={() => {
                  setTransferMode('WAITER');
                  setTransferError(null);
                }}
                type="button"
              >
                {t('order.toWaiter')}
              </button>
              <button
                className={`flex-1 py-2 rounded ${transferMode === 'TABLE' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                onClick={() => {
                  setTransferMode('TABLE');
                  setTransferError(null);
                }}
                type="button"
              >
                {t('order.toTable')}
              </button>
            </div>

            {transferMode === 'WAITER' ? (
              (() => {
                // Eligible = active, not me, not an admin, AND currently on shift.
                const eligibleWaiters = transferUsers
                  .filter((u) => u && u.active)
                  .filter((u) => Number(u.id) !== Number(user.id))
                  .filter((u) => String(u.role).toUpperCase() !== 'ADMIN')
                  .filter((u) => onShiftUserIds.has(Number(u.id)));
                return (
                  <div className="space-y-2">
                    <div className="text-sm opacity-80">
                      {t('order.selectWaiter')}
                    </div>
                    <select
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 disabled:opacity-60"
                      value={transferToUserId ?? ''}
                      onChange={(e) =>
                        setTransferToUserId(
                          e.target.value ? Number(e.target.value) : null,
                        )
                      }
                      disabled={eligibleWaiters.length === 0}
                    >
                      <option value="">
                        {eligibleWaiters.length === 0
                          ? t('order.noWaitersOnShift')
                          : t('order.chooseWaiter')}
                      </option>
                      {eligibleWaiters.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName}
                        </option>
                      ))}
                    </select>
                    <div className="text-xs opacity-70">
                      {t('order.waiterShiftHint')}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="space-y-2">
                <div className="text-sm opacity-80">
                  {t('order.destination')}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 disabled:opacity-60"
                    aria-label={t('order.destinationAriaSection')}
                    value={
                      transferSectionNames.includes(transferToArea)
                        ? transferToArea
                        : ''
                    }
                    onChange={(e) => {
                      setTransferToArea(e.target.value);
                      setTransferToLabel('');
                    }}
                    disabled={transferSectionNames.length === 0}
                  >
                    <option value="">
                      {transferSectionNames.length === 0
                        ? t('order.noSections')
                        : t('order.chooseSection')}
                    </option>
                    {transferSectionNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 disabled:opacity-60"
                    aria-label={t('order.destinationAriaTable')}
                    value={
                      transferDestTableOptions.includes(transferToLabel)
                        ? transferToLabel
                        : ''
                    }
                    onChange={(e) => setTransferToLabel(e.target.value)}
                    disabled={
                      !String(transferToArea || '').trim() ||
                      transferDestTableOptions.length === 0
                    }
                  >
                    <option value="">
                      {!String(transferToArea || '').trim()
                        ? t('order.chooseSectionFirst')
                        : transferDestTableOptions.length === 0
                          ? t('order.noFreeTable')
                          : t('order.chooseTable')}
                    </option>
                    {transferDestTableOptions.map((lab) => (
                      <option key={lab} value={lab}>
                        {lab}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {transferError && (
              <div className="mt-3 text-sm bg-rose-900/30 border border-rose-800 rounded p-2">
                {transferError}
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                className="flex-1 bg-gray-700 hover:bg-gray-600 py-2 rounded"
                onClick={() => setShowTransfer(false)}
                disabled={transferBusy}
              >
                {t('common.cancel')}
              </button>
              <button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded disabled:opacity-60"
                disabled={
                  transferBusy ||
                  !canTransfer ||
                  (transferMode === 'WAITER'
                    ? !transferToUserId
                    : !transferToArea.trim() ||
                      !transferToLabel.trim() ||
                      transferDestTableOptions.length === 0)
                }
                onClick={async () => {
                  if (!selectedTable || !user?.id) return;
                  setTransferBusy(true);
                  setTransferError(null);
                  try {
                    // Block transfer if destination table is already occupied.
                    // We toast as well as set the inline error so the warning
                    // is visible regardless of where the user is looking
                    // (modal vs. floor view), matching how covers/void
                    // failures are surfaced elsewhere in this page.
                    if (transferMode === 'TABLE') {
                      const destArea = transferToArea.trim();
                      const destLabel = transferToLabel.trim();
                      if (
                        destArea === selectedTable.area &&
                        destLabel === selectedTable.label
                      ) {
                        const msg = t('order.destinationSame');
                        toast.warn(msg, { title: t('order.transferBlocked') });
                        setTransferError(msg);
                        setTransferBusy(false);
                        return;
                      }
                      if (isOpen(destArea, destLabel)) {
                        const msg = t('order.destinationOccupied', {
                          area: destArea,
                          label: destLabel,
                        });
                        toast.error(msg, { title: t('order.transferBlocked') });
                        setTransferError(msg);
                        setTransferBusy(false);
                        return;
                      }
                    }
                    const transferIdempotencyKey =
                      typeof globalThis.crypto !== 'undefined' &&
                      typeof globalThis.crypto.randomUUID === 'function'
                        ? globalThis.crypto.randomUUID()
                        : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
                    const payload: any = {
                      fromArea: selectedTable.area,
                      fromLabel: selectedTable.label,
                      actorUserId: user.id,
                      actorRole: user.role,
                      idempotencyKey: transferIdempotencyKey,
                    };
                    if (transferMode === 'WAITER') {
                      payload.toUserId = transferToUserId;
                    } else {
                      payload.toArea = transferToArea.trim();
                      payload.toLabel = transferToLabel.trim();
                    }
                    const r: any = await (window.api.tables as any).transfer(
                      payload,
                    );
                    if (!r || r.ok !== true) {
                      const errMsg = String(
                        r?.error || t('order.transferFailedGeneric'),
                      );
                      // Race-condition safety net: another waiter may have
                      // opened the destination between our pre-flight check
                      // and the server hitting the open-tables map. The
                      // server-side error string is `Destination table X Y
                      // is already open` — toast it loudly so it isn't
                      // missed if the modal scrolled out of view.
                      if (/already open|already occupied/i.test(errMsg)) {
                        toast.error(errMsg, {
                          title: t('order.transferBlocked'),
                        });
                      }
                      setTransferError(errMsg);
                      return;
                    }

                    if (transferMode === 'TABLE') {
                      const toA = transferToArea.trim();
                      const toL = transferToLabel.trim();
                      setOpen(selectedTable.area, selectedTable.label, false);
                      setOpen(toA, toL, true);
                      setSelectedTable({
                        ...selectedTable,
                        area: toA,
                        label: toL,
                      });
                      const latest = await window.api.tickets
                        .getLatestForTable(toA, toL)
                        .catch(() => null as any);
                      if (latest?.items) {
                        useTicketStore.getState().hydrate({
                          items: latest.items as any,
                          note: latest.note || '',
                        });
                      }
                    }

                    setShowTransfer(false);
                  } catch (e: any) {
                    setTransferError(
                      String(
                        e?.message || e || t('order.transferFailedGeneric'),
                      ),
                    );
                  } finally {
                    setTransferBusy(false);
                  }
                }}
              >
                {transferBusy ? t('order.transferring') : t('order.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCovers && selectedTable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">
              {coversMode === 'editOnly'
                ? `${t('order.coversEditTitle')} ${selectedTable.label}`
                : `${t('order.coversOpenTitle')} ${selectedTable.label}`}
            </h3>
            <input
              autoFocus
              type="number"
              min={1}
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={coversValue}
              onChange={(e) => setCoversValue(e.target.value)}
            />
            <div className="flex gap-2 mt-4">
              <button
                className="flex-1 bg-gray-600 py-2 rounded"
                onClick={() => setShowCovers(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded"
                onClick={async () => {
                  const num = Number(coversValue);
                  if (!Number.isFinite(num) || num <= 0) return;
                  if (coversMode === 'editOnly') {
                    // Defense-in-depth: ownership rule for cover edits.
                    if (!canEditCovers) {
                      toast.warn(t('order.coversNotAllowed'), {
                        title: t('order.notAllowed'),
                      });
                      setShowCovers(false);
                      return;
                    }
                    // Just update covers (no ticket logging/printing).
                    // PR 4a: dedupe so spamming the +/- buttons in
                    // the cover-edit modal collapses to one eventual
                    // write; queue when offline.
                    await tryOrQueue(
                      'covers.save',
                      {
                        area: selectedTable.area,
                        label: selectedTable.label,
                        covers: num,
                      },
                      {
                        dedupeKey: `covers.save:${selectedTable.area}:${selectedTable.label}`,
                      },
                    ).catch(() => {});
                    setCoversKnown(num);
                    setShowCovers(false);
                    return;
                  }

                  // openAndSend flow — persist session edges BEFORE flipping
                  // local `isOpen`. That way `covers:getLast` (session-scoped
                  // via `tables:openAt`) can't briefly return the previous
                  // payout's guest count while the covers UI effect races the
                  // handshake (same class of bug as stale ticket lines).
                  lastSendAtRef.current = Date.now();
                  lastSendTableRef.current = {
                    area: selectedTable.area,
                    label: selectedTable.label,
                  };
                  // IMPORTANT: when opening a table in cloud mode,
                  // set "open" first so the cloud "openAt" timestamp
                  // exists BEFORE we write covers/tickets (tooltip
                  // uses openAt as the session start).
                  // PR 4a: route through the queue so an offline
                  // open-and-send still records the table-open and
                  // covers (the ticket itself is already covered by
                  // logTicket → 'tickets.log').
                  await tryOrQueue(
                    'tables.setOpen',
                    {
                      area: selectedTable.area,
                      label: selectedTable.label,
                      open: true,
                    },
                    {
                      dedupeKey: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                    },
                  ).catch(() => {});
                  await tryOrQueue(
                    'covers.save',
                    {
                      area: selectedTable.area,
                      label: selectedTable.label,
                      covers: num,
                    },
                    {
                      dedupeKey: `covers.save:${selectedTable.area}:${selectedTable.label}`,
                    },
                  ).catch(() => {});
                  setCoversKnown(num);
                  setOpen(selectedTable.area, selectedTable.label, true);
                  setShowCovers(false);
                  const stagedOnly = lines.filter((l) => l.staged);
                  const isFireOrder = stagedOnly.length > 0;
                  const details = {
                    table: selectedTable.label,
                    area: selectedTable.area,
                    covers: num,
                    orderNote,
                    lines: lines.map((l) => ({
                      sku: l.sku,
                      name: l.name,
                      qty: l.qty,
                      unitPrice: l.unitPrice,
                      vatRate: l.vatRate,
                      note: l.note,
                      station: (l as any).station,
                      categoryId: (l as any).categoryId,
                      categoryName: (l as any).categoryName,
                    })),
                  };
                  const printLines = isFireOrder
                    ? stagedOnly.map((l) => ({
                        sku: l.sku,
                        name: l.name,
                        qty: l.qty,
                        unitPrice: l.unitPrice,
                        vatRate: l.vatRate,
                        note: l.note,
                        station: (l as any).station,
                        categoryId: (l as any).categoryId,
                        categoryName: (l as any).categoryName,
                      }))
                    : details.lines;
                  // (optional) send log
                  if (!user?.id) return;
                  const logResult = await logTicket({
                    userId: user.id,
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    covers: num,
                    items: details.lines,
                    note: orderNote,
                  });
                  if (!logResult.ok) {
                    // Same recovery path as the regular Send button:
                    // somebody else closed / claimed this table while
                    // this device was on the covers modal. Toast,
                    // resync the open-tables map, and bail before the
                    // print fires (which would otherwise create a
                    // ghost kitchen ticket).
                    toast.error(logResult.error, {
                      title: t('order.toastSendBlocked'),
                    });
                    try {
                      const open = await window.api.tables.listOpen();
                      if (Array.isArray(open)) {
                        const stillOpen = open.some(
                          (tbl: any) =>
                            tbl.area === selectedTable.area &&
                            tbl.label === selectedTable.label,
                        );
                        setOpen(
                          selectedTable.area,
                          selectedTable.label,
                          stillOpen,
                        );
                      }
                    } catch {
                      // ignore
                    }
                    return;
                  }
                  // Immediately dim and lock qty by marking all as sent (optimistic)
                  useTicketStore.getState().markAllAsSent();
                  await window.api.tickets.print({
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    covers: num,
                    items: printLines,
                    note: orderNote,
                    userName: user.displayName,
                    meta: {
                      userId: user.id,
                      kind: isFireOrder ? 'ORDER' : 'TICKET',
                      vatEnabled,
                      serviceChargeEnabled: serviceChargeCfg.enabled,
                      serviceChargeApplied: serviceChargeCfg.enabled,
                      serviceChargeMode: serviceChargeCfg.mode,
                      serviceChargeValue: serviceChargeCfg.value,
                      serviceChargeAmount: serviceChargeCfg.enabled
                        ? serviceChargeCfg.mode === 'PERCENT'
                          ? Math.max(
                              0,
                              (Number(totals.total || 0) *
                                Number(serviceChargeCfg.value || 0)) /
                                100,
                            )
                          : Math.max(0, Number(serviceChargeCfg.value || 0))
                        : 0,
                    },
                  });
                  // Keep this as a best-effort "ensure open" after printing.
                  await window.api.tables
                    .setOpen(selectedTable.area, selectedTable.label, true)
                    .catch(() => {});
                }}
              >
                {t('order.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {voidTarget && selectedTable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">{t('order.voidItemTitle')}</h3>
            <p className="text-sm opacity-80 text-center mb-4">
              {t('order.voidItemBody', {
                name: voidTarget.name,
                qty: voidTarget.qty,
                area: selectedTable.area,
                label: selectedTable.label,
              })}
            </p>
            <div className="flex gap-2 mt-2">
              <button
                className="flex-1 bg-gray-600 py-2 rounded"
                onClick={() => setVoidTarget(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="flex-1 bg-red-700 hover:bg-red-800 py-2 rounded disabled:opacity-60"
                disabled={ticketSyncing}
                onClick={async () => {
                  if (!user?.id) return;
                  let approvedByAdmin: {
                    userId: number;
                    userName: string;
                    approvalToken?: string;
                  } | null = null;
                  if (approvalsCfg.requireManagerPinForVoid) {
                    const approved = await requestAdminApproval(
                      t('order.approvalVoidItem'),
                    );
                    if (!approved) return;
                    approvedByAdmin = approved;
                  }
                  hydrateGenRef.current += 1; // cancel any in-flight background fetches
                  setTicketSyncing(true);
                  const vt = voidTarget; // capture before clearing modal
                  setVoidTarget(null);
                  try {
                    // PR 4a: voidItem becomes queue-able. Same shape
                    // as the live IPC; if we're offline, the void is
                    // recorded for replay and the optimistic UI below
                    // still proceeds (the line disappears for the
                    // user; the server-side void lands on reconnect).
                    await tryOrQueue('tickets.voidItem', {
                      userId: user.id,
                      area: selectedTable.area,
                      tableLabel: selectedTable.label,
                      actorRole: user.role,
                      item: {
                        name: vt.name,
                        qty: vt.qty,
                        unitPrice: vt.unitPrice,
                        vatRate: vt.vatRate,
                        note: vt.note,
                      },
                      ...(approvedByAdmin
                        ? {
                            approvedByAdminId: approvedByAdmin.userId,
                            approvedByAdminName: approvedByAdmin.userName,
                            approvedByAdminToken: approvedByAdmin.approvalToken,
                          }
                        : {}),
                    });
                    // Optimistically remove the voided line immediately
                    removeLine(vt.id);
                    // Re-sync ticket from server to ensure consistency
                    const latest = await window.api.tickets
                      .getLatestForTable(
                        selectedTable.area,
                        selectedTable.label,
                      )
                      .catch(() => null as any);
                    const remaining = ((latest?.items as any[]) || []).filter(
                      (it: any) => !it.voided,
                    );
                    if (remaining.length) {
                      useTicketStore.getState().hydrate({
                        items: remaining as any,
                        note: latest?.note || '',
                      });
                    } else {
                      // All items voided → free the table
                      useTicketStore
                        .getState()
                        .hydrate({ items: [], note: '' });
                      setOpen(selectedTable.area, selectedTable.label, false);
                      window.api.tables
                        .setOpen(selectedTable.area, selectedTable.label, false)
                        .catch(() => {});
                    }
                  } catch {
                    toast.error(t('order.voidItemFailed'));
                  } finally {
                    setTicketSyncing(false);
                  }
                }}
              >
                {t('order.voidConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {weightModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">{t('order.weightTitle')}</h3>
            <div className="mb-2 text-center opacity-80">
              {weightModal.name}
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[...'123456789'].map((d) => (
                <button
                  key={d}
                  className="bg-gray-700 py-2 rounded"
                  onClick={() => setWeightInput((v) => v + d)}
                >
                  {d}
                </button>
              ))}
              <button
                className="bg-gray-700 py-2 rounded"
                onClick={() => setWeightInput((v) => v + '0')}
              >
                0
              </button>
              <button
                className="bg-gray-700 py-2 rounded"
                onClick={() =>
                  setWeightInput((v) => (v.includes('.') ? v : v + '.'))
                }
              >
                .
              </button>
              <button
                className="bg-gray-700 py-2 rounded"
                onClick={() => setWeightInput('')}
              >
                {t('order.clear')}
              </button>
            </div>
            <div className="flex gap-2 mb-3">
              <button
                className="flex-1 bg-gray-700 py-2 rounded"
                onClick={() => setWeightInput((v) => v + ' kg')}
              >
                kg
              </button>
              <button
                className="flex-1 bg-gray-700 py-2 rounded"
                onClick={() => setWeightInput((v) => v + ' g')}
              >
                g
              </button>
            </div>
            <input
              className="w-full bg-gray-700 rounded px-2 py-2 text-center mb-3"
              placeholder={t('order.weightPlaceholder')}
              value={weightInput}
              onChange={(e) => setWeightInput(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                className="flex-1 bg-gray-600 py-2 rounded"
                onClick={() => setWeightModal(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded"
                onClick={() => {
                  if (!weightModal) return;
                  const raw = weightInput.trim().toLowerCase();
                  if (!raw) return;
                  let qty = 0;
                  if (raw.endsWith('kg'))
                    qty = Number(raw.replace('kg', '').trim());
                  else if (raw.endsWith('g'))
                    qty = Number(raw.replace('g', '').trim()) / 1000;
                  else qty = Number(raw);
                  if (!Number.isFinite(qty) || qty <= 0) return;
                  addItem({
                    sku: weightModal.sku,
                    name: weightModal.name,
                    unitPrice: weightModal.unitPrice,
                    vatRate: weightModal.vatRate,
                    qty,
                    station: (weightModal as any).station,
                    categoryId: (weightModal as any).categoryId,
                    categoryName: (weightModal as any).categoryName,
                  } as any);
                  setWeightModal(null);
                  setWeightInput('');
                }}
              >
                {t('order.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {approvalModal.open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-[92vw] max-w-sm p-5">
            <div className="text-lg font-semibold mb-1">
              {approvalModal.kind === 'ADMIN'
                ? t('order.adminApproval')
                : t('order.managerApproval')}
            </div>
            <div className="text-sm opacity-70 mb-3">
              {approvalModal.action}
            </div>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              className="w-full bg-gray-700 rounded px-3 py-2"
              placeholder={
                approvalModal.kind === 'ADMIN'
                  ? t('order.enterAdminPin')
                  : t('order.enterManagerPin')
              }
              value={approvalModal.pin}
              onChange={(e) =>
                setApprovalModal((s) => ({
                  ...s,
                  pin: e.target.value.replace(/[^0-9]/g, '').slice(0, 6),
                  error: null,
                }))
              }
              onKeyDown={async (e) => {
                if (e.key !== 'Enter') return;
                const pin = approvalModal.pin;
                try {
                  const r = await window.api.auth.verifyManagerPin(pin);
                  if (!r?.ok) {
                    setApprovalModal((s) => ({
                      ...s,
                      error:
                        approvalModal.kind === 'ADMIN'
                          ? t('order.invalidAdminPin')
                          : t('order.invalidManagerPin'),
                    }));
                    return;
                  }
                  setApprovalModal({
                    open: false,
                    action: '',
                    kind: 'MANAGER',
                    pin: '',
                    error: null,
                  });
                  approvalResolveRef.current?.({
                    userId: Number((r as any).userId || 0),
                    userName: String(
                      (r as any).userName ||
                        (approvalModal.kind === 'ADMIN'
                          ? t('common.admin')
                          : t('common.manager')),
                    ),
                    approvalToken:
                      String((r as any).approvalToken || '') || undefined,
                  });
                  approvalResolveRef.current = null;
                } catch (err: any) {
                  const status = Number(err?.status || 0);
                  const msg =
                    status === 401 || status === 403
                      ? t('order.sessionExpiredLogin')
                      : t('order.verifyPinFailed');
                  setApprovalModal((s) => ({ ...s, error: msg }));
                }
              }}
            />
            {approvalModal.error && (
              <div className="text-sm text-rose-300 mt-2">
                {approvalModal.error}
              </div>
            )}
            <div className="flex gap-2 mt-4">
              <button
                className="flex-1 bg-gray-700 hover:bg-gray-600 py-2 rounded"
                onClick={() => {
                  setApprovalModal({
                    open: false,
                    action: '',
                    kind: 'MANAGER',
                    pin: '',
                    error: null,
                  });
                  approvalResolveRef.current?.(null);
                  approvalResolveRef.current = null;
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                className="flex-1 bg-emerald-700 hover:bg-emerald-800 py-2 rounded"
                onClick={async () => {
                  const pin = approvalModal.pin;
                  try {
                    const r = await window.api.auth.verifyManagerPin(pin);
                    if (!r?.ok) {
                      setApprovalModal((s) => ({
                        ...s,
                        error:
                          approvalModal.kind === 'ADMIN'
                            ? t('order.invalidAdminPin')
                            : t('order.invalidManagerPin'),
                      }));
                      return;
                    }
                    setApprovalModal({
                      open: false,
                      action: '',
                      kind: 'MANAGER',
                      pin: '',
                      error: null,
                    });
                    approvalResolveRef.current?.({
                      userId: Number((r as any).userId || 0),
                      userName: String(
                        (r as any).userName ||
                          (approvalModal.kind === 'ADMIN'
                            ? t('common.admin')
                            : t('common.manager')),
                      ),
                      approvalToken:
                        String((r as any).approvalToken || '') || undefined,
                    });
                    approvalResolveRef.current = null;
                  } catch (err: any) {
                    const status = Number(err?.status || 0);
                    const msg =
                      status === 401 || status === 403
                        ? t('order.sessionExpiredLogin')
                        : t('order.verifyPinFailed');
                    setApprovalModal((s) => ({ ...s, error: msg }));
                  }
                }}
              >
                {t('common.approve')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function ForkKnifeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 2v8M9 2v8M6 6h3M7.5 10v12"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M15 2v9c0 1.5 1 2 2 2v11"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M15 6h4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PayMethodButton({
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
      type="button"
      className={`w-full flex items-center gap-3 px-3 py-4 rounded border ${active ? 'bg-blue-600 border-blue-500' : 'bg-gray-900/40 border-gray-700 hover:bg-gray-700/40'}`}
      onClick={onClick}
    >
      <span className="opacity-90">{children}</span>
      <span className="font-semibold">{label}</span>
    </button>
  );
}

function IconCash() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M3 7h18v10H3V7Z" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M7 12h4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconCard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M3 7h18v10H3V7Z" stroke="currentColor" strokeWidth="1.75" />
      <path d="M3 10h18" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M7 15h4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconReceipt() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 2h12v20l-2-1-2 1-2-1-2 1-2-1-2 1V2Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M9 7h6M9 11h6M9 15h6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconPrinter() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M6 9V3h12v6" stroke="currentColor" strokeWidth="1.75" />
      <path d="M6 17h12v4H6v-4Z" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M6 10H5a3 3 0 0 0-3 3v4h4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M18 10h1a3 3 0 0 1 3 3v4h-4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TicketTotals({
  totals,
  vatEnabled,
  serviceChargeCfg,
  applyServiceCharge,
  serviceChargeAmount,
}: {
  totals: { subtotal: number; vat: number; total: number };
  vatEnabled: boolean;
  serviceChargeCfg: {
    enabled: boolean;
    mode: 'PERCENT' | 'AMOUNT';
    value: number;
  };
  applyServiceCharge: boolean;
  serviceChargeAmount: number;
}) {
  const { t } = useTranslation();
  const formatAmount = useMemo(() => makeFormatAmount(), []);
  const totalWithService = Math.max(
    0,
    Number(totals.total || 0) + Number(serviceChargeAmount || 0),
  );
  return (
    <>
      <div className="flex justify-between">
        <span>{t('common.subtotal')}</span>
        <span> {formatAmount(totals.subtotal)}</span>
      </div>
      {vatEnabled ? (
        <div className="flex justify-between">
          <span>{t('common.vat')}</span>
          <span> {formatAmount(totals.vat)}</span>
        </div>
      ) : (
        <div className="flex justify-between">
          <span>{t('common.vat')}</span>
          <span className="opacity-70">{t('common.vatDisabled')}</span>
        </div>
      )}
      {serviceChargeCfg.enabled && (
        <div className="flex justify-between">
          <span>{t('common.serviceCharge')}</span>
          {applyServiceCharge ? (
            <span> {formatAmount(serviceChargeAmount)}</span>
          ) : (
            <span className="opacity-70">{t('common.removed')}</span>
          )}
        </div>
      )}
      <div className="flex justify-between font-semibold">
        <span>{t('common.total')}</span>
        <span> {formatAmount(totalWithService)}</span>
      </div>
    </>
  );
}

function computeTotals(
  lines: Array<{ unitPrice: number; qty: number; vatRate: number }>,
  vatEnabled = true,
) {
  const subtotal = (lines || []).reduce(
    (s, l) => s + Number(l.unitPrice || 0) * Number(l.qty || 0),
    0,
  );
  const vat = vatEnabled
    ? (lines || []).reduce(
        (s, l) =>
          s +
          Number(l.unitPrice || 0) *
            Number(l.qty || 0) *
            Number(l.vatRate || 0),
        0,
      )
    : 0;
  const total = subtotal + vat;
  return { subtotal, vat, total };
}

// makeFormatAmount imported from utils/format
