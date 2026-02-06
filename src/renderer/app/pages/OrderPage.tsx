import { useEffect, useMemo, useRef, useState } from 'react';
import { useTicketStore } from '../../stores/ticket';
import { useOrderContext } from '../../stores/orderContext';
import { useTableStatus } from '../../stores/tableStatus';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/session';
import { logTicket } from '../../api';
import { useFavourites } from '../../stores/favourites';
import { makeFormatAmount } from '../../utils/format';

type MenuItemDTO = {
  id: number;
  name: string;
  sku: string;
  price: number;
  vatRate: number;
  active: boolean;
  categoryId: number;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
};
type MenuCategoryDTO = {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  items: MenuItemDTO[];
};

export default function OrderPage() {
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
  const { setOpen, isOpen } = useTableStatus();
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

  // Transfer table (move table and/or change owner)
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferMode, setTransferMode] = useState<'WAITER' | 'TABLE'>(
    'WAITER',
  );
  const [transferUsers, setTransferUsers] = useState<
    Array<{ id: number; displayName: string; role: string; active: boolean }>
  >([]);
  const [transferToUserId, setTransferToUserId] = useState<number | null>(null);
  const [transferToArea, setTransferToArea] = useState<string>('');
  const [transferToLabel, setTransferToLabel] = useState<string>('');
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);

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

  function formatElapsed(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (hh > 0)
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

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

  // Track covers for the selected table (used to gate "Pay")
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedTable) {
        setCoversKnown(undefined);
        return;
      }
      if (!isTableOpen) {
        setCoversKnown(null);
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
    ((v: { userId: number; userName: string } | null) => void) | null
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
        name: 'Favourites',
        sortOrder: -999,
        active: true,
        items,
      } as any;
    }
    return categories.find((c) => c.id === selectedCatId) ?? categories[0];
  }, [categories, selectedCatId, favouriteSkus]);

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

  useEffect(() => {
    loadMenu();
  }, []);

  // Prefill transfer UI when opened
  useEffect(() => {
    if (!showTransfer) return;
    if (!selectedTable) return;
    setTransferError(null);
    setTransferToArea(selectedTable.area);
    setTransferToLabel(selectedTable.label);
    setTransferToUserId(null);
    (async () => {
      const users = await window.api.auth.listUsers().catch(() => [] as any[]);
      setTransferUsers(
        (Array.isArray(users) ? users : []).filter((u: any) => u && u.active),
      );
    })();
  }, [showTransfer, selectedTable?.area, selectedTable?.label]);

  // Determine owner of the currently selected open table
  useEffect(() => {
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
        setOwnerId(data?.userId ?? null);
      } catch {
        setOwnerId(null);
      }
    })();
  }, [
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
  ]);

  // Hydrate lines from server when selecting a table or on refresh
  useEffect(() => {
    (async () => {
      if (!selectedTable) return;
      // Only hydrate for tables currently marked as open
      if (!isOpen(selectedTable.area, selectedTable.label)) return;
      try {
        const latest = await window.api.tickets.getLatestForTable(
          selectedTable.area,
          selectedTable.label,
        );
        const items = Array.isArray(latest?.items) ? latest!.items : [];
        const remaining = items.filter((it: any) => !it.voided);
        if (remaining.length) {
          useTicketStore
            .getState()
            .hydrate({ items: remaining as any, note: latest?.note || '' });
        }
      } catch (e) {
        void e;
      }
    })();
  }, [
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
  ]);

  // If an open table's ticket becomes empty due to voids, free the table (turn green) after server check
  useEffect(() => {
    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      return;
    }
    if (!selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (lines.length === 0) {
      if (suppressFreeOnEmptyRef.current) return;
      (async () => {
        try {
          const latest = await window.api.tickets.getLatestForTable(
            selectedTable.area,
            selectedTable.label,
          );
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
        setOpen(selectedTable.area, selectedTable.label, false);
        window.api.tables
          .setOpen(selectedTable.area, selectedTable.label, false)
          .catch(() => {});
      })();
    }
  }, [lines.length, selectedTable]);

  // Menu is managed by the business admin (no remote syncing).

  // Owner: poll for approved requests for current table and apply to ticket
  useEffect(() => {
    if (!user || !selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (ownerId == null || Number(ownerId) !== Number(user.id)) return;
    let timer: any;
    const tick = async () => {
      try {
        const rows = await window.api.requests.pollApprovedForTable(
          user.id,
          selectedTable.area,
          selectedTable.label,
        );
        if (Array.isArray(rows) && rows.length) {
          // Merge items into current ticket
          for (const r of rows) {
            const items = Array.isArray(r.items) ? r.items : [];
            for (const it of items) {
              addItem({
                sku: String(it.name),
                name: String(it.name),
                unitPrice: Number(it.unitPrice || 0),
                vatRate: Number(it.vatRate || 0),
              });
              // adjust quantity if >1
              const times = Math.max(1, Number(it.qty || 1)) - 1;
              for (let i = 0; i < times; i++) {
                const last = useTicketStore.getState().lines.slice(-1)[0];
                if (last) useTicketStore.getState().increment(last.id);
              }
            }
          }
          await window.api.requests.markApplied(rows.map((r: any) => r.id));
        }
      } finally {
        timer = setTimeout(tick, 4000);
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [user?.id, selectedTable?.area, selectedTable?.label, ownerId]);

  return (
    <div className="h-full min-h-0 flex flex-col md:grid md:grid-cols-3 md:gap-4 gap-3">
      {/* Mobile: switch between Menu and Ticket to avoid cramped 3-column layout */}
      <div className="md:hidden bg-gray-800/70 border border-gray-700 rounded-lg p-2 flex items-center gap-2">
        <button
          className={`flex-1 py-2 rounded ${mobilePane === 'menu' ? 'bg-emerald-700' : 'bg-gray-700'}`}
          onClick={() => setMobilePane('menu')}
          type="button"
        >
          Menu
        </button>
        <button
          className={`flex-1 py-2 rounded ${mobilePane === 'ticket' ? 'bg-emerald-700' : 'bg-gray-700'}`}
          onClick={() => setMobilePane('ticket')}
          type="button"
        >
          Ticket{lines.length ? ` (${lines.length})` : ''}
        </button>
      </div>

      <div
        className={`md:col-span-2 min-h-0 overflow-auto ${mobilePane === 'menu' ? 'flex-1' : 'hidden'} md:block`}
      >
        <div className="flex gap-2 mb-3">
          <input
            placeholder="Search menu..."
            className="w-full p-2 bg-gray-700 rounded"
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
            Favourites
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCatId(c.id)}
              className={`py-4 sm:py-7 px-2 border border-gray-700 hover:bg-gray-800 cursor-pointer rounded ${selected?.id === c.id ? 'bg-gray-800' : 'bg-gray-900'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {filteredItems.map((i: MenuItemDTO) => {
            const isFav = fav.isFav(user?.id || null, i.sku);
            const isDisabled = (i as any)?.active === false;
            return (
              <div key={i.id} className="relative">
                <button
                  className={`py-4 rounded text-left px-3 w-full ${
                    isDisabled
                      ? 'bg-gray-800/60 border border-gray-700 text-gray-400 cursor-not-allowed'
                      : 'bg-emerald-800 hover:bg-emerald-700 cursor-pointer'
                  }`}
                  onClick={() => {
                    if (isDisabled) return;
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
                  className={`absolute top-1 right-1 text-xs px-2 py-1 rounded ${isFav ? 'bg-pink-700' : 'bg-emerald-700'} cursor-pointer`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (user?.id) fav.toggle(user.id, i.sku);
                  }}
                  title={isFav ? 'Remove from favourites' : 'Add to favourites'}
                >
                  {isFav ? '♥' : '♡'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className={`bg-gray-800 p-3 rounded flex flex-col min-h-0 h-full relative ${mobilePane === 'ticket' ? 'flex-1' : 'hidden'} md:block`}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold flex items-center gap-2">
            <span>
              Ticket {selectedTable ? `- ${selectedTable.label}` : ''}
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
                title="Transfer this table to another waiter or table number"
              >
                Transfer
              </button>
            )}
            {selectedTable &&
              isOpen(selectedTable.area, selectedTable.label) && (
                <button
                  type="button"
                  className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded border border-gray-600"
                  onClick={() => {
                    setCoversMode('editOnly');
                    setCoversValue(
                      typeof coversKnown === 'number'
                        ? String(coversKnown)
                        : '',
                    );
                    setShowCovers(true);
                  }}
                  title="Edit guests (covers)"
                >
                  <ForkKnifeIcon />
                  <span className="text-sm font-semibold">
                    {typeof coversKnown === 'number' ? coversKnown : '—'}
                  </span>
                </button>
              )}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto pb-80">
          <div className="space-y-2">
            {lines.length === 0 ? (
              <div className="text-sm opacity-60">Select items to add…</div>
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
                            QTY:{l.qty}
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
                              title="Void"
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
                      placeholder="Add note (e.g., No onion, extra cheese)"
                      value={l.note ?? ''}
                      disabled={Boolean(
                        isTableOpen && !(showRequestOnly && l.staged),
                      )}
                      onChange={(e) => setLineNote(l.id, e.target.value)}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Sticky footer: order notes + totals + actions pinned to bottom */}
        <div className="absolute left-0 right-0 bottom-0 bg-gray-800 border-t border-gray-700 p-3">
          <div className="space-y-3 text-sm">
            <div>
              <label className="block text-xs mb-1 opacity-70">
                Order notes
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
                    placeholder="e.g., allergies, special instructions, table notes"
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
                          alert(
                            'Add items (new lines) before sending a request',
                          );
                          return;
                        }
                        if (!connectionOk) {
                          alert(
                            'Network is slow/offline. Please wait and try again.',
                          );
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
                          alert('Request sent to the owner');
                        } catch {
                          alert(
                            'Request failed (network slow). Please try again.',
                          );
                        } finally {
                          setBusyAction(null);
                        }
                      }}
                      type="button"
                    >
                      {busyAction === 'request'
                        ? 'Sending…'
                        : 'Request to add items'}
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
                        !connectionOk
                      }
                      onClick={async () => {
                        if (busyAction != null) return;
                        if (!connectionOk) {
                          alert(
                            'Network is slow/offline. Please wait and try again.',
                          );
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
                            } | null = null;
                            if (approvalsCfg.requireManagerPinForVoid) {
                              const approved = await requestAdminApproval(
                                'Admin PIN required to void ticket',
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

                            await window.api.tickets.voidTicket({
                              userId: user.id,
                              area: selectedTable.area,
                              tableLabel: selectedTable.label,
                              reason: orderNote || undefined,
                              ...(approvedByAdmin
                                ? {
                                    approvedByAdminId: approvedByAdmin.userId,
                                    approvedByAdminName:
                                      approvedByAdmin.userName,
                                  }
                                : {}),
                            });
                            // Persist free table server-side too (otherwise TablesPage refresh will re-mark it open).
                            await window.api.tables
                              .setOpen(
                                selectedTable.area,
                                selectedTable.label,
                                false,
                              )
                              .catch(() => {});
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
                          alert('Failed to void/clear. Please try again.');
                        } finally {
                          setBusyAction(null);
                        }
                      }}
                      type="button"
                    >
                      {busyAction === 'void'
                        ? 'Voiding…'
                        : selectedTable &&
                            isOpen(selectedTable.area, selectedTable.label)
                          ? 'Void Ticket'
                          : 'Clear'}
                    </button>
                    <button
                      className="flex-1 bg-blue-600 hover:bg-blue-700 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                      disabled={
                        lines.length === 0 ||
                        busyAction != null ||
                        !connectionOk
                      }
                      onClick={async () => {
                        if (busyAction != null) return;
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
                          alert(
                            'Network is slow/offline. Please wait and try again.',
                          );
                          return;
                        }
                        // Enrich log with details (table, order lines, notes, covers)
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
                          await logTicket({
                            userId: user.id,
                            area: selectedTable.area,
                            tableLabel: selectedTable.label,
                            covers: lastCovers ?? null,
                            items: details.lines,
                            note: orderNote,
                          });
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
                        } catch {
                          alert(
                            'Send failed (network slow). Please try again.',
                          );
                        } finally {
                          setBusyAction(null);
                        }
                      }}
                      type="button"
                    >
                      {busyAction === 'send'
                        ? 'Sending…'
                        : lines.some((l) => l.staged)
                          ? 'Send Order'
                          : 'Print Ticket'}
                    </button>
                    <button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                      disabled={!canPay || busyAction != null || !connectionOk}
                      title={
                        !selectedTable
                          ? 'Select table'
                          : lines.length === 0
                            ? 'Add items'
                            : !isTableOpen
                              ? 'Send the order and set guests before payment'
                              : hasUnsentItems
                                ? 'Send the order before payment'
                                : typeof coversKnown !== 'number' ||
                                    coversKnown <= 0
                                  ? 'Set guests before payment'
                                  : !connectionOk
                                    ? 'Network is slow/offline — wait before paying'
                                    : 'Pay'
                      }
                      onClick={async () => {
                        if (busyAction != null) return;
                        if (!selectedTable) {
                          setPendingAction('pay');
                          navigate('/app/tables');
                          return;
                        }
                        if (!connectionOk) {
                          alert(
                            'Network is slow/offline. Please wait and try again.',
                          );
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
                      {busyAction === 'pay' ? 'Paying…' : 'Pay'}
                    </button>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {showPayment && selectedTable && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-[92vw] max-w-6xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold">Payment</div>
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setShowPayment(false)}
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Order summary */}
              <div className="bg-gray-800 rounded-lg p-3 min-h-[280px] flex flex-col">
                <div className="text-sm opacity-80 mb-2">Order summary</div>
                <div className="text-xs opacity-60 mb-2">
                  Select the guests for payment
                </div>
                <div className="flex gap-2 mb-3">
                  <button
                    className="flex-1 bg-gray-700 rounded py-2 text-sm opacity-70"
                    disabled
                  >
                    Covers
                  </button>
                </div>
                <div className="flex-1 overflow-auto space-y-2">
                  <div className="bg-gray-700/60 rounded p-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">
                        Table {selectedTable.label}
                      </div>
                      <div className="text-xs opacity-70">
                        Covers:{' '}
                        {typeof coversKnown === 'number' ? coversKnown : '—'}
                      </div>
                    </div>
                    <div className="text-sm font-semibold">
                      {formatAmount(totals.total)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 text-sm opacity-80 flex justify-between">
                  <span>Total</span>
                  <span className="font-semibold">
                    {formatAmount(totals.total)}
                  </span>
                </div>
              </div>

              {/* Payment methods */}
              <div className="bg-gray-800 rounded-lg p-3 min-h-[280px]">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm opacity-80">Payment methods</div>
                </div>
                <div className="space-y-2">
                  <PayMethodButton
                    active={paymentMethod === 'CASH'}
                    onClick={() => setPaymentMethod('CASH')}
                    label="Cash"
                  >
                    <IconCash />
                  </PayMethodButton>
                  <div className="text-xs opacity-60 mt-3">Cards</div>
                  <PayMethodButton
                    active={paymentMethod === 'CARD'}
                    onClick={() => setPaymentMethod('CARD')}
                    label="Card"
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
                    Payment amount
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
                      <div className="text-sm font-medium">Service charge</div>
                      <div className="text-xs opacity-70">
                        {applyServiceCharge && serviceChargeAmount > 0
                          ? `+ ${formatAmount(serviceChargeAmount)}`
                          : '—'}
                      </div>
                    </div>
                    <label className="flex items-center justify-between gap-3">
                      <div className="text-sm opacity-80">
                        Apply service charge
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
                      Config:{' '}
                      {serviceChargeCfg.mode === 'PERCENT'
                        ? `${serviceChargeCfg.value}%`
                        : `${serviceChargeCfg.value}`}
                    </div>
                  </div>
                )}
                <div className="mt-3 p-3 rounded bg-gray-900/40 border border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-medium">Discount</div>
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
                          ? 'e.g. 10'
                          : discountType === 'AMOUNT'
                            ? 'e.g. 5.00'
                            : 'Select type'
                      }
                      value={discountValue}
                      disabled={discountType === 'NONE'}
                      onChange={(e) => setDiscountValue(e.target.value)}
                    />
                  </div>
                  <input
                    className="w-full bg-gray-700 rounded px-2 py-2 text-sm"
                    placeholder="Reason (optional)"
                    value={discountReason}
                    onChange={(e) => setDiscountReason(e.target.value)}
                  />
                  {discountAmount > 0 && (
                    <div className="text-xs opacity-70 mt-2 flex items-center justify-between">
                      <span>Total after discount</span>
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
                        Manager PIN required to complete this payment.
                      </div>
                    );
                  })()}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <IconPrinter />
                      <span className="text-sm">Print receipt</span>
                    </div>
                    <button
                      type="button"
                      className={`w-12 h-7 rounded-full relative ${printReceipt ? 'bg-blue-600' : 'bg-gray-700'}`}
                      onClick={() => setPrintReceipt((v) => !v)}
                      aria-label="Toggle print receipt"
                    >
                      <span
                        className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${printReceipt ? 'left-6' : 'left-1'}`}
                      />
                    </button>
                  </div>
                  <button
                    className="w-full bg-emerald-700 hover:bg-emerald-800 rounded py-4 font-semibold"
                    disabled={busyAction != null || !connectionOk}
                    onClick={async () => {
                      if (busyAction != null) return;
                      if (!connectionOk) return;
                      setBusyAction('pay');
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
                              ? 'Approve discount & service charge removal'
                              : needsDiscountApproval
                                ? 'Approve discount'
                                : 'Approve service charge removal',
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
                        await window.api.tickets
                          .print({
                            area: selectedTable.area,
                            tableLabel: selectedTable.label,
                            covers: lastCovers ?? null,
                            items,
                            note: orderNote || null,
                            userName: user?.displayName || undefined,
                            recordOnly: !printReceipt,
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
                          })
                          .catch(() => {});
                        setOpen(selectedTable.area, selectedTable.label, false);
                        await window.api.tables
                          .setOpen(
                            selectedTable.area,
                            selectedTable.label,
                            false,
                          )
                          .catch(() => {});
                        clear();
                        setOrderNote('');
                        setShowPayment(false);
                      } catch {
                        alert('Payment action failed. Please try again.');
                      } finally {
                        setBusyAction(null);
                      }
                    }}
                  >
                    Pay • {formatAmount(totalDue)}
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
              <div className="text-lg font-semibold">Transfer table</div>
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setShowTransfer(false)}
              >
                Close
              </button>
            </div>

            <div className="text-sm opacity-80 mb-3">
              From:{' '}
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
                To waiter
              </button>
              <button
                className={`flex-1 py-2 rounded ${transferMode === 'TABLE' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                onClick={() => {
                  setTransferMode('TABLE');
                  setTransferError(null);
                }}
                type="button"
              >
                To table
              </button>
            </div>

            {transferMode === 'WAITER' ? (
              <div className="space-y-2">
                <div className="text-sm opacity-80">Select waiter</div>
                <select
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2"
                  value={transferToUserId ?? ''}
                  onChange={(e) =>
                    setTransferToUserId(
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                >
                  <option value="">(choose waiter)</option>
                  {transferUsers
                    .filter((u) => u && u.active)
                    .filter((u) => Number(u.id) !== Number(user.id))
                    .filter((u) => String(u.role).toUpperCase() !== 'ADMIN')
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName}
                      </option>
                    ))}
                </select>
                <div className="text-xs opacity-70">
                  The other waiter will receive a notification.
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-sm opacity-80">Destination</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2"
                    value={transferToArea}
                    onChange={(e) => setTransferToArea(e.target.value)}
                    placeholder={selectedTable.area}
                  />
                  <input
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2"
                    value={transferToLabel}
                    onChange={(e) => setTransferToLabel(e.target.value)}
                    placeholder="e.g. T12"
                  />
                </div>
                <div className="text-xs opacity-70">
                  Tip: your layout uses labels like <b>T1</b>, <b>T2</b>, etc.
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
                Cancel
              </button>
              <button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded disabled:opacity-60"
                disabled={
                  transferBusy ||
                  !canTransfer ||
                  (transferMode === 'WAITER'
                    ? !transferToUserId
                    : !transferToArea.trim() || !transferToLabel.trim())
                }
                onClick={async () => {
                  if (!selectedTable || !user?.id) return;
                  setTransferBusy(true);
                  setTransferError(null);
                  try {
                    const payload: any = {
                      fromArea: selectedTable.area,
                      fromLabel: selectedTable.label,
                      actorUserId: user.id,
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
                      setTransferError(String(r?.error || 'Transfer failed'));
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
                        useTicketStore
                          .getState()
                          .hydrate({
                            items: latest.items as any,
                            note: latest.note || '',
                          });
                      }
                    }

                    setShowTransfer(false);
                  } catch (e: any) {
                    setTransferError(
                      String(e?.message || e || 'Transfer failed'),
                    );
                  } finally {
                    setTransferBusy(false);
                  }
                }}
              >
                {transferBusy ? 'Transferring…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCovers && selectedTable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">
              {coversMode === 'editOnly' ? 'Edit guests' : 'Guests for table'}{' '}
              {selectedTable.label}
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
                Cancel
              </button>
              <button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded"
                onClick={async () => {
                  const num = Number(coversValue);
                  if (!Number.isFinite(num) || num <= 0) return;
                  if (coversMode === 'editOnly') {
                    // Just update covers (no ticket logging/printing)
                    await window.api.covers.save(
                      selectedTable.area,
                      selectedTable.label,
                      num,
                    );
                    setCoversKnown(num);
                    setShowCovers(false);
                    return;
                  }

                  // openAndSend flow
                  setCoversKnown(num);
                  setOpen(selectedTable.area, selectedTable.label, true);
                  setShowCovers(false);
                  // IMPORTANT: when opening a table in cloud mode, set "open" first so the
                  // cloud "openAt" timestamp exists BEFORE we write covers/tickets (tooltip uses openAt as the session start).
                  await window.api.tables
                    .setOpen(selectedTable.area, selectedTable.label, true)
                    .catch(() => {});
                  await window.api.covers.save(
                    selectedTable.area,
                    selectedTable.label,
                    num,
                  );
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
                  await logTicket({
                    userId: user.id,
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    covers: num,
                    items: details.lines,
                    note: orderNote,
                  });
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
                Konfirmo
              </button>
            </div>
          </div>
        </div>
      )}

      {voidTarget && selectedTable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">Void item?</h3>
            <p className="text-sm opacity-80 text-center mb-4">
              {voidTarget.name} ×{voidTarget.qty} on {selectedTable.area} •{' '}
              {selectedTable.label}
            </p>
            <div className="flex gap-2 mt-2">
              <button
                className="flex-1 bg-gray-600 py-2 rounded"
                onClick={() => setVoidTarget(null)}
              >
                Cancel
              </button>
              <button
                className="flex-1 bg-red-700 hover:bg-red-800 py-2 rounded"
                onClick={async () => {
                  if (!user?.id) return;
                  let approvedByAdmin: {
                    userId: number;
                    userName: string;
                  } | null = null;
                  if (approvalsCfg.requireManagerPinForVoid) {
                    const approved = await requestAdminApproval(
                      'Admin PIN required to void item',
                    );
                    if (!approved) return;
                    approvedByAdmin = approved;
                  }
                  await window.api.tickets.voidItem({
                    userId: user.id,
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    item: {
                      name: voidTarget.name,
                      qty: voidTarget.qty,
                      unitPrice: voidTarget.unitPrice,
                      vatRate: voidTarget.vatRate,
                      note: voidTarget.note,
                    },
                    ...(approvedByAdmin
                      ? {
                          approvedByAdminId: approvedByAdmin.userId,
                          approvedByAdminName: approvedByAdmin.userName,
                        }
                      : {}),
                  });
                  removeLine(voidTarget.id);
                  setVoidTarget(null);
                }}
              >
                Konfirmo Anullimin
              </button>
            </div>
          </div>
        </div>
      )}

      {weightModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">Enter weight (kg or g)</h3>
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
                Clear
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
              placeholder="e.g., 0.35 kg or 350 g"
              value={weightInput}
              onChange={(e) => setWeightInput(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                className="flex-1 bg-gray-600 py-2 rounded"
                onClick={() => setWeightModal(null)}
              >
                Cancel
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
                Konfirmo
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
                ? 'Admin approval'
                : 'Manager approval'}
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
                  ? 'Enter admin PIN'
                  : 'Enter manager PIN'
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
                          ? 'Invalid admin PIN.'
                          : 'Invalid manager PIN.',
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
                        (approvalModal.kind === 'ADMIN' ? 'Admin' : 'Manager'),
                    ),
                  });
                  approvalResolveRef.current = null;
                } catch (err: any) {
                  const status = Number(err?.status || 0);
                  const msg =
                    status === 401 || status === 403
                      ? 'Session expired. Please log in again.'
                      : 'Could not verify PIN (offline/host unreachable). Please try again.';
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
                Cancel
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
                            ? 'Invalid admin PIN.'
                            : 'Invalid manager PIN.',
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
                            ? 'Admin'
                            : 'Manager'),
                      ),
                    });
                    approvalResolveRef.current = null;
                  } catch (err: any) {
                    const status = Number(err?.status || 0);
                    const msg =
                      status === 401 || status === 403
                        ? 'Session expired. Please log in again.'
                        : 'Could not verify PIN (offline/host unreachable). Please try again.';
                    setApprovalModal((s) => ({ ...s, error: msg }));
                  }
                }}
              >
                Approve
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
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M15 2v9c0 1.5 1 2 2 2v11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M15 6h4"
        stroke="currentColor"
        strokeWidth="2"
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
      <path d="M3 7h18v10H3V7Z" stroke="currentColor" strokeWidth="2" />
      <path
        d="M7 12h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconCard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M3 7h18v10H3V7Z" stroke="currentColor" strokeWidth="2" />
      <path d="M3 10h18" stroke="currentColor" strokeWidth="2" />
      <path
        d="M7 15h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconGift() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M4 11h16v10H4V11Z" stroke="currentColor" strokeWidth="2" />
      <path d="M12 11v10" stroke="currentColor" strokeWidth="2" />
      <path d="M4 7h16v4H4V7Z" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 7c-1.5-3-4-3-4-1s4 1 4 1Zm0 0c1.5-3 4-3 4-1s-4 1-4 1Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconRoom() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M4 10h16v11H4V10Z" stroke="currentColor" strokeWidth="2" />
      <path d="M7 10V6h10v4" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 14h8"
        stroke="currentColor"
        strokeWidth="2"
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
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M9 7h6M9 11h6M9 15h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconPrinter() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M6 9V3h12v6" stroke="currentColor" strokeWidth="2" />
      <path d="M6 17h12v4H6v-4Z" stroke="currentColor" strokeWidth="2" />
      <path
        d="M6 10H5a3 3 0 0 0-3 3v4h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M18 10h1a3 3 0 0 1 3 3v4h-4"
        stroke="currentColor"
        strokeWidth="2"
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
  const formatAmount = useMemo(() => makeFormatAmount(), []);
  const totalWithService = Math.max(
    0,
    Number(totals.total || 0) + Number(serviceChargeAmount || 0),
  );
  return (
    <>
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span> {formatAmount(totals.subtotal)}</span>
      </div>
      {vatEnabled ? (
        <div className="flex justify-between">
          <span>VAT</span>
          <span> {formatAmount(totals.vat)}</span>
        </div>
      ) : (
        <div className="flex justify-between">
          <span>VAT</span>
          <span className="opacity-70">Disabled</span>
        </div>
      )}
      {serviceChargeCfg.enabled && (
        <div className="flex justify-between">
          <span>Service charge</span>
          {applyServiceCharge ? (
            <span> {formatAmount(serviceChargeAmount)}</span>
          ) : (
            <span className="opacity-70">Removed</span>
          )}
        </div>
      )}
      <div className="flex justify-between font-semibold">
        <span>Total</span>
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
