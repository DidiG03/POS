import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useTicketStore,
  toTicketLogLine,
  type TicketLogItem,
} from '../../stores/ticket';
import { sumTicketLinesNetVat } from '@shared/ticketRevenue';
import {
  computeDiscountAmount,
  computeServiceChargeAmount,
  roundMoney,
} from '@shared/pricing';
import {
  cashChangeDue,
  cashTenderSuggestions,
  parseEurExchangeRate,
  splitEvenly,
  toEurAtRate,
} from '@shared/paymentDisplay';
import { tableKey } from '@shared/utils/tableKey';
import {
  restoreMissingServerLines,
  shouldKeepLocalDraftOnEmptyLog,
} from '@shared/ticketDraft';
import { useOrderContext } from '@shared/stores/orderContext';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';
import { ensureStoreCounterSelected } from '@shared/editionCapabilities';
import { ORDER_ADD_MODES } from '@shared/orderAddMode';
import { useTableStatus } from '../../stores/tableStatus';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import { logTicket, printTicket } from '../../api';
import { tryOrQueue } from '../../utils/offlineQueue';
import { newIdempotencyKey } from '../../utils/idempotency';
import { useFavourites } from '../../stores/favourites';
import { formatEur, makeFormatAmount } from '../../utils/format';
import { toast } from '../../stores/toasts';
import { PageSpinner } from '../../components/PageSpinner';
import { TicketCourseBoard } from '../components/TicketCourseBoard';
import {
  courseNumber,
  kitchenSlipNeedsCourseBanner,
  selectFireLines,
} from '@shared/ticketCourseFire';
import {
  seatLabel,
  seatNumber,
  shouldCloseTableAfterSeatPay,
  unpaidLinesForSeat,
  unpaidSeatIds,
} from '@shared/ticketSeats';
import { saneTableAreas } from '@shared/tableAreas';
import {
  IconAlert,
  IconCard,
  IconCash,
  IconChevronLeft,
  IconClose,
  IconCovers,
  IconGrid,
  IconList,
  IconOrderCourse,
  IconOrderDefault,
  IconOrderSeat,
  IconPrinter,
  IconReceipt,
} from '../../components/icons';
import { pollIntervalMs } from '../../utils/netQuality';
import { usePosUiTheme } from '../../theme';
import { FALLBACK_MENU_TILE_BG, menuTileStyle } from '@shared/menuTileColor';
import {
  invalidateFloorCache,
  invalidateTicketCache,
  peekFloorSnapshot,
  peekLatestTicket,
  peekMenu,
} from '../../utils/posReadCache';
import { readTicketForTable } from '../../utils/ticketRead';
import {
  cacheLooksLikeCurrentSession,
  hasLocalCovers,
  shouldKeepCoversOnlyTableOpen,
} from '../../utils/tableSessionKeepOpen';
import {
  createHidBarcodeBuffer,
  findItemByProductCode,
} from '@shared/barcodeScan';

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
  stockLevel?: 'OK' | 'LOW' | 'OUT';
  stockRemaining?: number | null;
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

const FALLBACK_TILE_BG = FALLBACK_MENU_TILE_BG;
const FAVOURITES_CAT_ID = -1;
const COMMENTS_CAT_ID = -2;
const COMMENT_TILE_BG = '#3d4d63';
const COMMENT_CUSTOM_BTN_BG = '#2563eb';

function mergeNoteFragment(existing: string, fragment: string): string {
  const base = String(existing || '').trim();
  const text = String(fragment || '').trim();
  if (!text) return base;
  if (!base) return text;
  const parts = base.split(/[,;]\s*/).map((p) => p.trim().toLowerCase());
  if (parts.includes(text.toLowerCase())) return base;
  return `${base}, ${text}`;
}

function lineAcceptsComment(
  line: { voided?: boolean; staged?: boolean },
  ticketOpen: boolean,
  requestOnly: boolean,
): boolean {
  if (line.voided) return false;
  const dimmed = ticketOpen && !line.staged;
  if (dimmed && !(requestOnly && line.staged)) return false;
  return true;
}

function menuItemUnavailable(item: MenuItemDTO): boolean {
  if (!item.active) return true;
  if (item.stockLevel === 'OUT') return true;
  if (
    item.stockLevel === 'LOW' &&
    item.stockRemaining != null &&
    item.stockRemaining <= 0
  )
    return true;
  return false;
}

function menuItemLowStock(item: MenuItemDTO): boolean {
  if (!item.active || item.stockLevel !== 'LOW') return false;
  if (item.stockRemaining != null && item.stockRemaining <= 0) return false;
  return true;
}

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

function activeTicketItems<T extends { voided?: boolean; paid?: boolean }>(
  items: T[],
): T[] {
  return items.filter((it) => !it?.voided && !it?.paid);
}

/**
 * The host's copy of this sitting's ticket, read past the SWR cache so a
 * stale entry cannot resurrect a line that was just voided. Failing to read
 * must not block a send, so an unreachable host answers "nothing".
 */
async function liveServerTicketLines(
  area: string,
  label: string,
): Promise<TicketLogItem[]> {
  try {
    invalidateTicketCache(area, label);
    const latest = await window.api.tickets.getLatestForTable(area, label);
    return Array.isArray(latest?.items)
      ? (latest!.items as TicketLogItem[])
      : [];
  } catch {
    return [];
  }
}

/** Covers-only sits have no TicketLog yet — do not treat that as "table is free". */
async function sessionHasCovers(
  area: string,
  label: string,
  known: number | null | undefined,
): Promise<boolean> {
  if (hasLocalCovers(known)) return true;
  try {
    const last = await window.api.covers.getLast(area, label);
    return typeof last === 'number' && last > 0;
  } catch {
    return false;
  }
}

/** Persists waiter-created quick comment buttons across page reloads. */
const CUSTOM_COMMENT_BUTTONS_KEY = 'pos_custom_comment_buttons_v1';

function loadCustomCommentButtons(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(CUSTOM_COMMENT_BUTTONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        const phrases = value.filter(
          (v): v is string => typeof v === 'string' && v.trim() !== '',
        );
        if (phrases.length) out[key] = phrases;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const MENU_LAYOUT_KEY = 'pos.order.menuLayout';
type MenuLayout = 'grid' | 'column';

function readMenuLayout(): MenuLayout {
  try {
    return localStorage.getItem(MENU_LAYOUT_KEY) === 'column'
      ? 'column'
      : 'grid';
  } catch {
    return 'grid';
  }
}

function writeMenuLayout(layout: MenuLayout) {
  try {
    localStorage.setItem(MENU_LAYOUT_KEY, layout);
  } catch {
    // ignore quota / private-mode failures
  }
}

export default function OrderPage() {
  const { t } = useTranslation();
  const cachedMenu = peekMenu<MenuCategoryDTO[]>();
  const [categories, setCategories] = useState<MenuCategoryDTO[]>(() =>
    Array.isArray(cachedMenu) ? cachedMenu : [],
  );
  const [selectedCatId, setSelectedCatId] = useState<number | null>(() =>
    Array.isArray(cachedMenu) && cachedMenu[0] ? cachedMenu[0].id : null,
  );
  const [query, setQuery] = useState('');
  const [menuLayout, setMenuLayout] = useState<MenuLayout>(readMenuLayout);
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
    markLineVoided,
    activeCourseId,
    addMode,
    setAddMode,
    bindTable,
    hasHydrated: ticketPersistReady,
    seats,
    activeSeatId,
    markLinesAsPaid,
  } = useTicketStore();
  const [weightModal, setWeightModal] = useState<{
    sku: string;
    name: string;
    unitPrice: number;
    vatRate: number;
  } | null>(null);
  const [weightInput, setWeightInput] = useState<string>('');
  const [weightUnit, setWeightUnit] = useState<'kg' | 'g'>('kg');
  const [customCommentOpen, setCustomCommentOpen] = useState(false);
  const [customCommentInput, setCustomCommentInput] = useState('');
  const customCommentInputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Waiter-created quick buttons for the current table — not order text until tapped. */
  const [customCommentButtonsByTable, setCustomCommentButtonsByTable] =
    useState<Record<string, string[]>>(loadCustomCommentButtons);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const { selectedTable, setPendingAction, setSelectedTable } =
    useOrderContext();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const uiTheme = usePosUiTheme();
  const { setOpen, setAll, isOpen } = useTableStatus();

  useEffect(() => {
    if (!ticketPersistReady) return;
    bindTable(
      selectedTable ? tableKey(selectedTable.area, selectedTable.label) : null,
    );
  }, [
    ticketPersistReady,
    bindTable,
    selectedTable?.area,
    selectedTable?.label,
  ]);
  const [openLoaded, setOpenLoaded] = useState(
    () => Object.keys(useTableStatus.getState().openMap).length > 0,
  );
  const [openLoadError, setOpenLoadError] = useState<string | null>(null);
  const [ticketLoaded, setTicketLoaded] = useState(false);
  /** The host's bill could not be read — distinct from "the bill is empty". */
  const [ticketLoadFailed, setTicketLoadFailed] = useState(false);
  const [ticketReloadNonce, setTicketReloadNonce] = useState(0);
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
  const [posCurrency, setPosCurrency] = useState<string>('EUR');
  const [eurExchangeRate, setEurExchangeRate] = useState<number | null>(null);
  const [splitGuestCount, setSplitGuestCount] = useState(1);
  const [cashTendered, setCashTendered] = useState('');
  const [amountPaid, setAmountPaid] = useState<string>('');
  const [printReceipt, setPrintReceipt] = useState<boolean>(true);
  const [paySeatId, setPaySeatId] = useState<string | null>(null);
  const [printStationTickets, setPrintStationTickets] = useState<boolean>(true);
  const [discountType, setDiscountType] = useState<
    'NONE' | 'PERCENT' | 'AMOUNT'
  >('NONE');
  const [discountValue, setDiscountValue] = useState<string>('');
  const [discountReason, setDiscountReason] = useState<string>('');
  const [vatEnabled, setVatEnabled] = useState<boolean>(false);
  const [defaultVatRate, setDefaultVatRate] = useState<number>(0.2);
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

  useEffect(() => {
    ensureStoreCounterSelected({
      hasTables,
      userId: user?.id,
      selectedTable,
      setSelectedTable,
    });
    if (!hasTables) setOrderNote('');
    if (!hasTables && selectedCatId === COMMENTS_CAT_ID) {
      setSelectedCatId(categories[0]?.id ?? FAVOURITES_CAT_ID);
    }
  }, [
    hasTables,
    user?.id,
    selectedTable,
    setSelectedTable,
    setOrderNote,
    selectedCatId,
    categories,
  ]);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [openedAtMs, setOpenedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const suppressFreeOnEmptyRef = useRef(false);
  const initialRenderRef = useRef(true);
  /** Table whose "still open" answer from the host we already took over. */
  const adoptedHostOpenRef = useRef<string | null>(null);
  /**
   * Incremented on every void AND on every table switch; background effects
   * use it to cancel stale fetches so a slow response from a previous table
   * cannot overwrite state for the table the user is currently viewing.
   */
  const hydrateGenRef = useRef(0);
  /** Separate from hydrate so a transfer can flip ownership without
   *  cancelling an in-flight ticket reload. */
  const ownerFetchGenRef = useRef(0);
  /** Set when we send or are about to send; prevents overwriting with empty during server sync delay */
  const lastSendAtRef = useRef(0);
  const lastSendTableRef = useRef<{ area: string; label: string } | null>(null);
  const [requestLocked, setRequestLocked] = useState(false);
  const [busyAction, setBusyAction] = useState<
    'send' | 'pay' | 'void' | 'request' | null
  >(null);
  // Writes go through the durable queue. Never freeze Send/Pay because a
  // heartbeat timed out on congested Wi-Fi — that is the rush-hour failure.
  const connectionOk = true;
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
  /**
   * An occupied table whose bill we could not read. Sending or paying now
   * would act on a check we cannot see, so both are held until a retry
   * succeeds.
   */
  const billUnknown = isTableOpen && ticketLoadFailed;
  const activeLines = useMemo(() => lines.filter((l) => !l.voided), [lines]);
  /**
   * A sitting with nothing left but paid lines is settled money against a
   * filed invoice. The host refuses to void it; the button says so rather
   * than failing after the manager has typed their PIN.
   */
  const ticketFullySettled =
    activeLines.length > 0 && activeLines.every((l) => l.paid === true);
  const billableLines = useMemo(
    () => lines.filter((l) => !l.voided && !l.paid),
    [lines],
  );
  const payLines = useMemo(() => {
    if (showPayment && addMode === 'seat' && paySeatId) {
      return unpaidLinesForSeat(lines, paySeatId);
    }
    return billableLines;
  }, [showPayment, addMode, paySeatId, lines, billableLines]);
  const payingSeatName = useMemo(() => {
    if (addMode !== 'seat' || !paySeatId) return null;
    return seatLabel(
      seats,
      paySeatId,
      t('order.seatN', { n: seatNumber(seats, paySeatId) || 1 }),
    );
  }, [addMode, paySeatId, seats, t]);
  const seatPayRows = useMemo(() => {
    if (addMode !== 'seat') return [];
    return seats.map((seat, i) => {
      const unpaid = unpaidLinesForSeat(lines, seat.id);
      const gross = unpaid.reduce(
        (sum, l) => sum + Number(l.qty || 0) * Number(l.unitPrice || 0),
        0,
      );
      return {
        id: seat.id,
        label: seatLabel(seats, seat.id, t('order.seatN', { n: i + 1 })),
        paid: unpaid.length === 0,
        gross: roundMoney(gross),
      };
    });
  }, [addMode, seats, lines, t]);
  const hasUnsentItems = lines.some((l) => l.staged && !l.voided);
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

  const ensureStoreTillOpen = useCallback(async () => {
    if (hasTables || !selectedTable) return;
    if (isOpen(selectedTable.area, selectedTable.label)) return;
    suppressFreeOnEmptyRef.current = true;
    setCoversKnown(1);
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
        covers: 1,
      },
      {
        dedupeKey: `covers.save:${selectedTable.area}:${selectedTable.label}`,
      },
    ).catch(() => {});
    setOpen(selectedTable.area, selectedTable.label, true);
    await window.api.tables
      .setOpen(selectedTable.area, selectedTable.label, true)
      .catch(() => {});
  }, [hasTables, selectedTable, isOpen, setOpen]);

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
          timer = setTimeout(poll, pollIntervalMs(4000, hidden));
        }
      }
    };
    fetchOnce().then(() => {
      if (!cancelled && gen === orderPollGenRef.current) {
        timer = setTimeout(poll, pollIntervalMs(4000, false));
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

  useEffect(() => {
    setSelectedLineId(null);
    setTicketLoadFailed(false);
  }, [selectedTable?.area, selectedTable?.label]);

  // Load ticket snapshot for open tables before rendering the page (prevents empty->pop-in on refresh).
  useEffect(() => {
    let cancelled = false;
    const gen = hydrateGenRef.current;
    (async () => {
      if (!ticketPersistReady || !openLoaded) return;
      if (!selectedTable) {
        setTicketLoaded(true);
        return;
      }
      // Closed tables keep the persisted local draft (unsent items + add mode).
      // But "closed" here is a local flag, and a wrong one hides a live bill:
      // every ticket read below is skipped, so the panel shows an empty cart
      // for an occupied table. Confirm with the host before believing it.
      if (!isOpen(selectedTable.area, selectedTable.label)) {
        const table = selectedTable;
        const key = tableKey(table.area, table.label);
        // Once per table only. A sitting with neither lines nor covers gets
        // freed further down, and if that close cannot reach the host we
        // would otherwise keep re-adopting its "still open" answer.
        if (adoptedHostOpenRef.current === key) {
          setTicketLoaded(true);
          return;
        }
        const hostSaysOpen = await window.api.tables
          .listOpen()
          .then(
            (open) =>
              Array.isArray(open) &&
              open.some(
                (row: { area?: string; label?: string }) =>
                  row?.area === table.area && row?.label === table.label,
              ),
          )
          .catch(() => false);
        if (cancelled || gen !== hydrateGenRef.current) return;
        if (!hostSaysOpen) {
          setTicketLoaded(true);
          return;
        }
        // Adopting the host's answer re-runs this effect, which then loads
        // the sitting's ticket.
        adoptedHostOpenRef.current = key;
        setOpen(table.area, table.label, true);
        return;
      }
      const cached = peekLatestTicket(selectedTable.area, selectedTable.label);
      const snap = peekFloorSnapshot(selectedTable.area);
      const openedAt = snap?.tables?.find(
        (row) =>
          row.area === selectedTable.area && row.label === selectedTable.label,
      )?.openedAt;
      const cacheFresh = cacheLooksLikeCurrentSession(cached, openedAt);
      if (cached?.items && cacheFresh) {
        useTicketStore.getState().hydrate({
          items: cached.items as any,
          note: cached.note || '',
        });
        setTicketLoaded(true);
      } else {
        setTicketLoaded(false);
      }
      try {
        const read = await readTicketForTable(
          selectedTable.area,
          selectedTable.label,
        );
        if (cancelled || gen !== hydrateGenRef.current) return;
        if (!read.ok) {
          // The bill is unknown, not empty. An empty cart on an occupied
          // table reads as "nothing ordered" and invites a Send that
          // rewrites the sitting.
          setTicketLoadFailed(true);
          return;
        }
        setTicketLoadFailed(false);
        const items = read.items;
        if (items.length) {
          useTicketStore
            .getState()
            .hydrate({ items: items as any, note: read.note });
          if (
            activeTicketItems(
              useTicketStore.getState().lines as Array<{ voided?: boolean }>,
            ).length === 0 &&
            selectedTable
          ) {
            invalidateTicketCache(selectedTable.area, selectedTable.label);
            setOpen(selectedTable.area, selectedTable.label, false);
            window.api.tables
              .setOpen(selectedTable.area, selectedTable.label, false)
              .catch(() => {});
          }
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
          if (shouldKeepLocalDraftOnEmptyLog(currentLines)) return;
          useTicketStore.getState().hydrate({ items: [], note: read.note });
          if (selectedTable) {
            const keepOpen = shouldKeepCoversOnlyTableOpen({
              latestHadLines: false,
              suppressClose: suppressFreeOnEmptyRef.current,
              localCovers: coversKnown,
              serverCovers: hasLocalCovers(coversKnown)
                ? coversKnown
                : (await sessionHasCovers(
                      selectedTable.area,
                      selectedTable.label,
                      coversKnown,
                    ))
                  ? 1
                  : null,
            });
            if (keepOpen) return;
            invalidateTicketCache(selectedTable.area, selectedTable.label);
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
    ticketPersistReady,
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
    ticketReloadNonce,
  ]);

  // Track covers for the selected table (used to gate "Pay")
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!hasTables) {
        setCoversKnown(1);
        return;
      }
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
        setCoversKnown((prev) => {
          if (typeof last === 'number' && last > 0) return last;
          if (typeof prev === 'number' && prev > 0) return prev;
          return last ?? null;
        });
      } catch {
        if (cancelled) return;
        setCoversKnown((prev) =>
          typeof prev === 'number' && prev > 0 ? prev : null,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasTables, selectedTable?.area, selectedTable?.label, isTableOpen]);

  const canPay = hasTables
    ? Boolean(selectedTable) &&
      billableLines.length > 0 &&
      isTableOpen &&
      !hasUnsentItems &&
      typeof coversKnown === 'number' &&
      coversKnown > 0
    : Boolean(selectedTable) && billableLines.length > 0;

  const totals = useMemo(
    () => computeTotals(payLines, vatEnabled, defaultVatRate),
    [payLines, vatEnabled, defaultVatRate],
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
      setVatEnabled(Boolean((s as any)?.fiscal?.enabled));
      setPosCurrency(
        String((s as any)?.currency || 'EUR')
          .trim()
          .toUpperCase() || 'EUR',
      );
      setEurExchangeRate(
        parseEurExchangeRate((s as any)?.fiscal?.eurExchangeRate),
      );
      const dvr = Number((s as any)?.defaultVatRate);
      setDefaultVatRate(Number.isFinite(dvr) && dvr > 0 ? dvr : 0.2);
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
    const onSettings = () => {
      void reloadPreferences();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('pos:settingsChanged', onSettings);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pos:settingsChanged', onSettings);
    };
  }, []);

  const serviceChargeAmount = useMemo(
    () =>
      computeServiceChargeAmount(
        Number(totals.total || 0),
        serviceChargeCfg,
        applyServiceCharge,
      ),
    [
      serviceChargeCfg.enabled,
      serviceChargeCfg.mode,
      serviceChargeCfg.value,
      applyServiceCharge,
      totals.total,
    ],
  );

  // Service charge amount as configured (ignores waiter toggle). Used for approval checks.
  const serviceChargeConfiguredAmount = useMemo(
    () =>
      computeServiceChargeAmount(
        Number(totals.total || 0),
        serviceChargeCfg,
        true,
      ),
    [
      serviceChargeCfg.enabled,
      serviceChargeCfg.mode,
      serviceChargeCfg.value,
      totals.total,
    ],
  );

  const totalBeforeDiscount = roundMoney(
    Math.max(0, Number(totals.total || 0) + serviceChargeAmount),
  );
  const discountAmount = useMemo(
    () =>
      computeDiscountAmount(
        totalBeforeDiscount,
        discountType,
        String(discountValue || '').replace(',', '.'),
      ),
    [discountType, discountValue, totalBeforeDiscount],
  );
  const totalDue = roundMoney(
    Math.max(0, totalBeforeDiscount - discountAmount),
  );
  const formatAmount = useMemo(() => makeFormatAmount(), []);
  const eurDue = useMemo(
    () => toEurAtRate(totalDue, eurExchangeRate),
    [totalDue, eurExchangeRate],
  );
  const split = useMemo(
    () => splitEvenly(totalDue, splitGuestCount),
    [totalDue, splitGuestCount],
  );
  const eurPerPerson = useMemo(
    () => (split ? toEurAtRate(split.perPerson, eurExchangeRate) : null),
    [split, eurExchangeRate],
  );
  const cashSuggestions = useMemo(
    () =>
      cashTenderSuggestions(
        totalDue,
        eurExchangeRate != null ? 'ALL' : posCurrency,
      ),
    [totalDue, posCurrency, eurExchangeRate],
  );
  const cashTenderedNum = Number(String(cashTendered || '').replace(',', '.'));
  const cashChange = cashChangeDue(cashTenderedNum, totalDue);

  useEffect(() => {
    if (!showPayment) return;
    const n =
      typeof coversKnown === 'number' && coversKnown > 0
        ? Math.floor(coversKnown)
        : 1;
    setSplitGuestCount(n);
    setCashTendered('');
    if (addMode === 'seat') {
      const ids = unpaidSeatIds(seats, lines);
      setPaySeatId((cur) =>
        cur && ids.includes(cur) ? cur : (ids[0] ?? null),
      );
    } else {
      setPaySeatId(null);
    }
  }, [showPayment]);

  const fav = useFavourites();
  const favouriteSkus = fav.list(user?.id || null);
  const commentPresets = useMemo(() => {
    const raw = t('order.commentPresets', { returnObjects: true });
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => String(s || '').trim()).filter(Boolean);
  }, [t]);
  const selected = useMemo(() => {
    if (selectedCatId === FAVOURITES_CAT_ID) {
      const items = categories
        .flatMap((c) => c.items)
        .filter((i) => favouriteSkus.includes(i.sku));
      return {
        id: FAVOURITES_CAT_ID,
        name: t('order.favourites'),
        sortOrder: -999,
        active: true,
        items,
      } as any;
    }
    if (selectedCatId === COMMENTS_CAT_ID) {
      return {
        id: COMMENTS_CAT_ID,
        name: t('order.comments'),
        sortOrder: -998,
        active: true,
        items: [],
      } as any;
    }
    return categories.find((c) => c.id === selectedCatId) ?? categories[0];
  }, [categories, selectedCatId, favouriteSkus, t]);

  const appendOrderComment = useCallback(
    (phrase: string) => {
      const text = String(phrase || '').trim();
      if (!text) return;
      const ticketOpen = Boolean(
        selectedTable && isOpen(selectedTable.area, selectedTable.label),
      );
      const requestOnly = Boolean(
        ticketOpen &&
          ownerId &&
          user?.id != null &&
          Number(ownerId) !== Number(user.id),
      );
      if (selectedLineId) {
        const line = lines.find((l) => l.id === selectedLineId);
        if (line && lineAcceptsComment(line, ticketOpen, requestOnly)) {
          setLineNote(selectedLineId, mergeNoteFragment(line.note ?? '', text));
          return;
        }
      }
      if (!hasTables) return;
      setOrderNote(mergeNoteFragment(orderNote, text));
    },
    [
      lines,
      orderNote,
      ownerId,
      selectedLineId,
      selectedTable,
      setLineNote,
      setOrderNote,
      user?.id,
      isOpen,
      hasTables,
    ],
  );

  const tableCommentKey = selectedTable
    ? `${selectedTable.area}:${selectedTable.label}`
    : null;
  const customCommentButtons = tableCommentKey
    ? (customCommentButtonsByTable[tableCommentKey] ?? [])
    : [];

  const appendCustomCommentButton = useCallback(
    (phrase: string) => {
      const text = String(phrase || '').trim();
      if (!text || !tableCommentKey) return;
      setCustomCommentButtonsByTable((prev) => {
        const cur = prev[tableCommentKey] ?? [];
        if (
          cur.some((c) => c.toLowerCase() === text.toLowerCase()) ||
          commentPresets.some((c) => c.toLowerCase() === text.toLowerCase())
        ) {
          return prev;
        }
        return { ...prev, [tableCommentKey]: [...cur, text] };
      });
    },
    [tableCommentKey, commentPresets],
  );

  // Persist waiter-created comment buttons so they survive a page refresh.
  useEffect(() => {
    try {
      localStorage.setItem(
        CUSTOM_COMMENT_BUTTONS_KEY,
        JSON.stringify(customCommentButtonsByTable),
      );
    } catch {
      // Ignore storage failures (e.g. private mode / quota).
    }
  }, [customCommentButtonsByTable]);

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

  const addMenuItemToSale = useCallback(
    (item: MenuItemDTO) => {
      if (menuItemUnavailable(item) || ticketSyncing || busyAction != null) {
        return;
      }
      const isKg =
        Boolean((item as any)?.isKg) || Boolean((item as any)?.tags?.isKg);
      if (isKg) {
        setWeightModal({
          sku: item.sku,
          name: item.name,
          unitPrice: item.price,
          vatRate: item.vatRate,
          station: item.station,
          categoryId: item.categoryId,
          categoryName:
            categoryNameById.get(Number(item.categoryId)) || undefined,
        } as any);
        setWeightInput('');
        setWeightUnit('kg');
        return;
      }
      addItem({
        sku: item.sku,
        name: item.name,
        unitPrice: item.price,
        vatRate: item.vatRate,
        station: item.station,
        categoryId: item.categoryId,
        categoryName:
          categoryNameById.get(Number(item.categoryId)) || undefined,
        courseId:
          addMode === 'course' && item.station !== 'BAR'
            ? activeCourseId
            : null,
        seatId: addMode === 'seat' ? activeSeatId : null,
      } as any);
    },
    [
      addItem,
      addMode,
      activeCourseId,
      activeSeatId,
      busyAction,
      categoryNameById,
      ticketSyncing,
    ],
  );

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

  // Store tills only: a USB scanner types the barcode then Enter.
  useEffect(() => {
    if (hasTables) return;
    const buffer = createHidBarcodeBuffer();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        showPayment ||
        showCovers ||
        showTransfer ||
        weightModal ||
        customCommentOpen
      ) {
        return;
      }
      if (ticketSyncing || busyAction != null) return;
      const target = e.target as HTMLElement | null;
      const tag = String(target?.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA' || target?.isContentEditable) return;

      const result = buffer.push(e.key, performance.now());
      if (result.swallow) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (!result.commit) return;
      setQuery('');
      const items = categories.flatMap((c) => c.items || []);
      const item = findItemByProductCode(items, result.commit);
      if (!item) {
        toast.error(t('order.barcodeUnknown'));
        return;
      }
      if (menuItemUnavailable(item)) {
        toast.error(t('order.barcodeUnavailable', { name: item.name }));
        return;
      }
      addMenuItemToSale(item);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    addMenuItemToSale,
    busyAction,
    categories,
    customCommentOpen,
    hasTables,
    showCovers,
    showPayment,
    showTransfer,
    t,
    ticketSyncing,
    weightModal,
  ]);

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
      const list = saneTableAreas(settings?.tableAreas);
      setTransferTableSections(list);
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

  const refreshTableOwner = useCallback(
    async (
      area?: string | null,
      label?: string | null,
      optimisticUserId?: number | null,
    ) => {
      const a = String(area || '').trim();
      const l = String(label || '').trim();
      const gen = ++ownerFetchGenRef.current;
      if (!a || !l) {
        setOwnerId(null);
        return;
      }
      const optimistic = Number(optimisticUserId);
      if (Number.isFinite(optimistic) && optimistic > 0) {
        setOwnerId(optimistic);
      }
      try {
        const data = await window.api.tickets.getLatestForTable(a, l);
        if (gen !== ownerFetchGenRef.current) return;
        const fetched = Number(data?.userId);
        if (Number.isFinite(optimistic) && optimistic > 0) {
          if (Number.isFinite(fetched) && fetched !== optimistic) return;
        }
        setOwnerId(Number.isFinite(fetched) && fetched > 0 ? fetched : null);
      } catch {
        if (gen !== ownerFetchGenRef.current) return;
        if (!(Number.isFinite(optimistic) && optimistic > 0)) setOwnerId(null);
      }
    },
    [],
  );

  // Determine owner of the currently selected open table
  useEffect(() => {
    if (!selectedTable) {
      ownerFetchGenRef.current += 1;
      setOwnerId(null);
      return;
    }
    if (!isOpen(selectedTable.area, selectedTable.label)) {
      ownerFetchGenRef.current += 1;
      setOwnerId(null);
      return;
    }
    void refreshTableOwner(selectedTable.area, selectedTable.label);
  }, [
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
    refreshTableOwner,
  ]);

  useEffect(() => {
    const applyLatest = async () => {
      if (!selectedTable) return;
      const gen = hydrateGenRef.current;
      const table = selectedTable;
      try {
        const read = await readTicketForTable(table.area, table.label);
        if (gen !== hydrateGenRef.current) return;
        if (!read.ok) {
          setTicketLoadFailed(true);
          return;
        }
        setTicketLoadFailed(false);
        const items = read.items;
        if (
          items.length > 0 &&
          items.every((it: { voided?: boolean }) => it?.voided === true)
        ) {
          useTicketStore.getState().clear();
          return;
        }
        if (items.length) {
          useTicketStore.getState().hydrate({
            items: items as any,
            note: read.note,
          });
          return;
        }
        if (suppressFreeOnEmptyRef.current || hasLocalCovers(coversKnown)) {
          return;
        }
        const currentLines = useTicketStore.getState().lines;
        if (shouldKeepLocalDraftOnEmptyLog(currentLines)) return;
        useTicketStore.getState().hydrate({ items: [], note: read.note });
      } catch {
        // next poll / hydrate effect will retry
      }
    };

    const onTicketsChanged = (ev: Event) => {
      const detail = (ev as CustomEvent).detail || {};
      const area = String(detail.area || '');
      const tableLabel = String(detail.tableLabel || '');
      if (!selectedTable) return;
      if (area !== selectedTable.area || tableLabel !== selectedTable.label) {
        return;
      }
      invalidateTicketCache(selectedTable.area, selectedTable.label);
      const uid = Number(detail.userId);
      void refreshTableOwner(
        selectedTable.area,
        selectedTable.label,
        Number.isFinite(uid) && uid > 0 ? uid : null,
      );
      void applyLatest();
    };

    const onCatchup = () => {
      void window.api.tables
        .listOpen()
        .then((open) => {
          if (Array.isArray(open)) setAll(open);
        })
        .catch(() => undefined);
      void applyLatest();
    };

    window.addEventListener('pos:ticketsChanged', onTicketsChanged);
    window.addEventListener('pos:syncCatchup', onCatchup);
    return () => {
      window.removeEventListener('pos:ticketsChanged', onTicketsChanged);
      window.removeEventListener('pos:syncCatchup', onCatchup);
    };
  }, [
    selectedTable?.area,
    selectedTable?.label,
    refreshTableOwner,
    coversKnown,
    setAll,
  ]);

  // Tablets (and cloud) often miss the SSE ticket event. Re-read owner
  // while this table is open so a transfer on another device flips the
  // ticket to request-only without a refresh.
  useEffect(() => {
    if (!selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const area = selectedTable.area;
    const label = selectedTable.label;
    const tick = () => {
      if (cancelled) return;
      const hidden =
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden';
      if (!hidden) void refreshTableOwner(area, label);
      timer = setTimeout(tick, pollIntervalMs(4000, hidden));
    };
    timer = setTimeout(tick, pollIntervalMs(4000, false));
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void refreshTableOwner(area, label);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
    refreshTableOwner,
  ]);

  // Hydrate lines from server when selecting a table or on refresh.
  // Skip while ticketSyncing — the void flow handles its own re-sync.
  useEffect(() => {
    if (ticketSyncing) return;
    const gen = hydrateGenRef.current;
    // The ticket store is global. Without this the reply to a slow fetch can
    // land after the waiter has already backed out and opened another table,
    // writing the previous table's lines into the check they are looking at.
    let cancelled = false;
    (async () => {
      if (!ticketPersistReady) return;
      if (!selectedTable) return;
      // Only hydrate for tables currently marked as open
      if (!isOpen(selectedTable.area, selectedTable.label)) return;
      try {
        const read = await readTicketForTable(
          selectedTable.area,
          selectedTable.label,
        );
        // Stale fetch — a void or new action happened while this was in flight
        if (cancelled || gen !== hydrateGenRef.current) return;
        if (!read.ok) {
          setTicketLoadFailed(true);
          return;
        }
        setTicketLoadFailed(false);
        const items = read.items;
        if (items.length) {
          useTicketStore
            .getState()
            .hydrate({ items: items as any, note: read.note });
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
          if (suppressFreeOnEmptyRef.current || hasLocalCovers(coversKnown)) {
            return;
          }
          if (shouldKeepLocalDraftOnEmptyLog(currentLines)) return;
          useTicketStore.getState().hydrate({ items: [], note: read.note });
        }
      } catch (e) {
        void e;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
    ticketPersistReady,
    ticketSyncing,
    coversKnown,
  ]);

  // If an open table's ticket becomes empty due to voids, free the table (turn green) after server check.
  // Skip while ticketSyncing is active — the void flow handles the re-sync itself.
  useEffect(() => {
    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      return;
    }
    if (ticketSyncing) return;
    if (!ticketPersistReady) return;
    if (!selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (activeLines.length === 0) {
      if (suppressFreeOnEmptyRef.current) return;
      const gen = hydrateGenRef.current;
      (async () => {
        let latestHadLines = false;
        try {
          const read = await readTicketForTable(
            selectedTable.area,
            selectedTable.label,
          );
          if (gen !== hydrateGenRef.current) return;
          if (!read.ok) {
            // Freeing a sitting whose bill we could not read would drop a
            // live check off the floor. Keep it open and surface the error.
            setTicketLoadFailed(true);
            return;
          }
          setTicketLoadFailed(false);
          const items = read.items;
          latestHadLines = items.length > 0;
          if (
            items.length &&
            activeTicketItems(items as Array<{ voided?: boolean }>).length > 0
          ) {
            // Rehydrate and keep table open
            useTicketStore
              .getState()
              .hydrate({ items: items as any, note: read.note });
            setOpen(selectedTable.area, selectedTable.label, true);
            return;
          }
        } catch (e) {
          void e;
        }
        if (gen !== hydrateGenRef.current) return;
        const keepOpen = shouldKeepCoversOnlyTableOpen({
          latestHadLines,
          suppressClose: suppressFreeOnEmptyRef.current,
          localCovers: coversKnown,
          serverCovers: (await sessionHasCovers(
            selectedTable.area,
            selectedTable.label,
            coversKnown,
          ))
            ? 1
            : null,
        });
        if (keepOpen) return;
        invalidateTicketCache(selectedTable.area, selectedTable.label);
        setOpen(selectedTable.area, selectedTable.label, false);
        window.api.tables
          .setOpen(selectedTable.area, selectedTable.label, false)
          .catch(() => {});
      })();
    }
  }, [
    activeLines.length,
    lines.length,
    selectedTable,
    ticketSyncing,
    ticketPersistReady,
  ]);

  // Menu is managed by the business admin (no remote syncing).

  // Owner: poll for approved requests for current table and apply to ticket.
  // Uses an `alive` flag so async work that resolves after unmount/cleanup
  // does not mutate the ticket store, and reschedules only while alive.
  const appliedRequestIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!hasTables) return;
    if (!user || !selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (ownerId == null || Number(ownerId) !== Number(user.id)) return;
    appliedRequestIdsRef.current = new Set();
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
        // The host keeps returning a request until it is marked applied. When
        // that call fails — a blip on the tablet's Wi-Fi is enough — the next
        // poll four seconds later hands back the same request and the
        // colleague's items land on the check a second time.
        const fresh = (Array.isArray(rows) ? rows : []).filter(
          (r: any) => !appliedRequestIdsRef.current.has(Number(r?.id)),
        );
        if (fresh.length) {
          for (const r of fresh) {
            appliedRequestIdsRef.current.add(Number(r.id));
            const items = Array.isArray(r.items) ? r.items : [];
            for (const it of items) {
              addItem({
                sku: String(it.name),
                name: String(it.name),
                unitPrice: Number(it.unitPrice || 0),
                vatRate: Number(it.vatRate || 0),
                station: it.station,
                courseId:
                  addMode === 'course' &&
                  String(it.station || '').toUpperCase() !== 'BAR'
                    ? activeCourseId
                    : null,
                seatId: addMode === 'seat' ? activeSeatId : null,
              });
              const times = Math.max(1, Number(it.qty || 1)) - 1;
              for (let i = 0; i < times; i++) {
                const last = useTicketStore.getState().lines.slice(-1)[0];
                if (last) useTicketStore.getState().increment(last.id);
              }
            }
          }
        }
        // Retry the acknowledgement for everything we have applied and the
        // host still considers outstanding, so it stops resending them.
        const outstanding = (Array.isArray(rows) ? rows : [])
          .map((r: any) => Number(r?.id))
          .filter((id: number) => Number.isFinite(id));
        if (outstanding.length) {
          await window.api.requests.markApplied(outstanding).catch(() => {});
        }
      } finally {
        if (alive) timer = setTimeout(tick, pollIntervalMs(4000, false));
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [
    hasTables,
    user?.id,
    selectedTable?.area,
    selectedTable?.label,
    ownerId,
    addItem,
    addMode,
    activeCourseId,
    activeSeatId,
  ]);

  const runKitchenFire = useCallback(
    async (opts: {
      covers: number | null;
      courseId?: string | null;
      firstSend: boolean;
      printKitchen: boolean;
    }): Promise<{ ok: boolean; isFireOrder: boolean }> => {
      if (!selectedTable || !user?.id) {
        return { ok: false, isFireOrder: false };
      }
      const state = useTicketStore.getState();
      const fireLines = selectFireLines({
        lines: state.lines,
        courses: state.courses,
        courseMode: addMode === 'course',
        courseId: opts.courseId,
        firstSend: opts.firstSend,
      });
      const hasStaged = state.lines.some((l) => l.staged && !l.voided);
      const isFireOrder = fireLines.length > 0;
      const firingIds = new Set(fireLines.map((l) => l.id));
      // A ticket log replaces the whole bill, so send what the host already
      // holds for this sitting plus our lines. Without this, a till whose
      // cart went stale (or empty) silently drops items off the bill.
      const onServer = await liveServerTicketLines(
        selectedTable.area,
        selectedTable.label,
      );
      const logItems = restoreMissingServerLines(
        state.lines.map((l) =>
          toTicketLogLine(l, {
            fired:
              l.voided === true || l.staged !== true || firingIds.has(l.id),
          }),
        ),
        onServer,
      );
      const printLines = isFireOrder
        ? fireLines.map((l) => toTicketLogLine(l))
        : logItems;
      const courseIdForLabel =
        String(opts.courseId || '').trim() ||
        (addMode === 'course'
          ? opts.firstSend
            ? state.courses[0]?.id
            : fireLines.find((l) => l.courseId)?.courseId ||
              state.courses[0]?.id
          : null);
      const n = courseNumber(state.courses, courseIdForLabel);
      const courseLabel =
        addMode === 'course' && n && kitchenSlipNeedsCourseBanner(printLines)
          ? t('order.courseN', { n })
          : undefined;
      const serviceChargeAmount = serviceChargeCfg.enabled
        ? serviceChargeCfg.mode === 'PERCENT'
          ? Math.max(
              0,
              (Number(totals.total || 0) *
                Number(serviceChargeCfg.value || 0)) /
                100,
            )
          : Math.max(0, Number(serviceChargeCfg.value || 0))
        : 0;
      const printMeta = {
        userId: user.id,
        kind: isFireOrder ? ('ORDER' as const) : ('TICKET' as const),
        vatEnabled,
        courseLabel: isFireOrder ? courseLabel : undefined,
        serviceChargeEnabled: serviceChargeCfg.enabled,
        serviceChargeApplied: serviceChargeCfg.enabled,
        serviceChargeMode: serviceChargeCfg.mode,
        serviceChargeValue: serviceChargeCfg.value,
        serviceChargeAmount,
      };

      if (hasStaged) {
        const logResult = await logTicket({
          userId: user.id,
          area: selectedTable.area,
          tableLabel: selectedTable.label,
          covers: opts.covers,
          items: logItems,
          note: state.orderNote,
          stockConsumeLines: fireLines.map((l) => ({
            sku: l.sku,
            qty: l.qty,
          })),
          kdsFireItems:
            opts.printKitchen && isFireOrder ? printLines : undefined,
          kdsCourseLabel: opts.printKitchen ? courseLabel : undefined,
        });
        if (!logResult.ok) {
          toast.error(logResult.error, {
            title: t('order.toastSendBlocked'),
          });
          try {
            const open = await window.api.tables.listOpen();
            if (Array.isArray(open)) {
              const stillOpen = open.some(
                (tbl: { area?: string; label?: string }) =>
                  tbl.area === selectedTable.area &&
                  tbl.label === selectedTable.label,
              );
              setOpen(selectedTable.area, selectedTable.label, stillOpen);
            }
          } catch {
            // toast is the source of truth
          }
          return { ok: false, isFireOrder };
        }
        useTicketStore.getState().markLinesAsSent(fireLines.map((l) => l.id));
      }

      if (opts.printKitchen && (isFireOrder || !hasStaged)) {
        await printTicket({
          area: selectedTable.area,
          tableLabel: selectedTable.label,
          covers: opts.covers,
          items: printLines,
          note: state.orderNote,
          userName: user.displayName,
          meta: printMeta,
        }).then((printed) => {
          if (printed?.queued) {
            toast.warn(
              isFireOrder
                ? t('order.kitchenPrintQueued')
                : t('order.ticketPrintQueued'),
            );
          }
        });
      }
      return { ok: true, isFireOrder };
    },
    [
      addMode,
      selectedTable,
      user?.id,
      user?.displayName,
      t,
      vatEnabled,
      serviceChargeCfg,
      totals.total,
      setOpen,
    ],
  );

  const printSeatBill = useCallback(
    async (seatId: string) => {
      if (!selectedTable || !user?.id || busyAction != null || ticketSyncing) {
        return;
      }
      const items = unpaidLinesForSeat(lines, seatId)
        .filter((l) => l.staged !== true)
        .map((l) => toTicketLogLine(l));
      if (items.length === 0) return;
      const n = seatNumber(seats, seatId);
      const label = seatLabel(seats, seatId, t('order.seatN', { n: n || 1 }));
      const lastCovers = await window.api.covers
        .getLast(selectedTable.area, selectedTable.label)
        .catch(() => null);
      setBusyAction('send');
      try {
        await printTicket({
          area: selectedTable.area,
          tableLabel: selectedTable.label,
          covers: lastCovers ?? null,
          items,
          note: orderNote || null,
          userName: user.displayName,
          meta: {
            userId: user.id,
            vatEnabled,
            seatLabel: label,
          },
        });
        toast.success(t('order.seatBillPrinted', { label }));
      } catch (e: unknown) {
        const raw = String(
          (e as { message?: string })?.message || e || '',
        ).trim();
        toast.error(raw || t('order.toastTryAgain'));
      } finally {
        setBusyAction(null);
      }
    },
    [
      busyAction,
      lines,
      orderNote,
      seats,
      selectedTable,
      t,
      ticketSyncing,
      user?.displayName,
      user?.id,
      vatEnabled,
    ],
  );

  const lockOrderScroll =
    !showPayment &&
    (ticketSyncing ||
      busyAction === 'send' ||
      busyAction === 'void' ||
      busyAction === 'request');

  useEffect(() => {
    if (!lockOrderScroll) return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevHtmlOverscroll = html.style.overscrollBehavior;
    const prevBodyOverscroll = body.style.overscrollBehavior;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none';
    body.style.overscrollBehavior = 'none';
    const preventScroll = (e: Event) => {
      e.preventDefault();
    };
    document.addEventListener('touchmove', preventScroll, { passive: false });
    document.addEventListener('wheel', preventScroll, { passive: false });
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      html.style.overscrollBehavior = prevHtmlOverscroll;
      body.style.overscrollBehavior = prevBodyOverscroll;
      document.removeEventListener('touchmove', preventScroll);
      document.removeEventListener('wheel', preventScroll);
    };
  }, [lockOrderScroll]);

  const cachedTicket =
    selectedTable && isTableOpen
      ? peekLatestTicket(selectedTable.area, selectedTable.label)
      : null;
  const shouldBlockForLoading =
    !cachedTicket &&
    lines.length === 0 &&
    categories.length === 0 &&
    (!openLoaded || !ticketLoaded);

  if (shouldBlockForLoading) {
    return (
      <PageSpinner
        message={
          openLoadError
            ? t(`order.loadErrors.${openLoadError}`)
            : !openLoaded
              ? t(hasTables ? 'order.loadingTables' : 'order.loadingSale')
              : t('order.loadingTicket')
        }
      />
    );
  }

  const columnMenu = menuLayout === 'column';
  const catShape = columnMenu
    ? 'w-full rounded-lg py-2.5 px-2 text-left text-[13px] leading-snug'
    : 'py-4 sm:py-7 px-2 rounded-xl';

  return (
    <div className="h-full min-h-0 min-w-0 w-full flex flex-col md:grid md:grid-cols-3 md:gap-4 gap-3 relative">
      {lockOrderScroll ? (
        <PageSpinner
          variant="lock"
          message={
            ticketSyncing
              ? t('order.syncingTicket')
              : busyAction === 'send'
                ? t('order.sendingOrder')
                : busyAction === 'void'
                  ? t('order.voiding')
                  : busyAction === 'request'
                    ? t('order.sending')
                    : t('order.pleaseWait')
          }
        />
      ) : null}
      {/* Mobile: switch between Menu and Ticket to avoid cramped 3-column layout */}
      <div className="md:hidden pos-surface-panel p-1.5 flex items-center gap-1.5">
        {hasTables ? (
          <button
            className="pos-icon-btn shrink-0 cursor-pointer text-gray-100"
            onClick={() => navigate('/app/tables')}
            type="button"
            aria-label={t('order.backToTables')}
            title={t('order.backToTables')}
          >
            <IconChevronLeft />
          </button>
        ) : null}
        <div className="pos-segmented flex-1">
          <button
            className={`pos-segment flex-1 ${mobilePane === 'menu' ? 'pos-segment--active' : ''}`}
            onClick={() => setMobilePane('menu')}
            type="button"
          >
            {t(hasTables ? 'order.menu' : 'order.catalog')}
          </button>
          <button
            className={`pos-segment flex-1 ${mobilePane === 'ticket' ? 'pos-segment--active' : ''}`}
            onClick={() => setMobilePane('ticket')}
            type="button"
          >
            {lines.length
              ? t(hasTables ? 'order.ticketCount' : 'order.cartCount', {
                  count: lines.length,
                })
              : t(hasTables ? 'order.ticket' : 'order.cart')}
          </button>
        </div>
      </div>

      <div
        className={`md:col-span-2 min-h-0 min-w-0 h-full flex-col ${
          mobilePane === 'menu' ? 'flex flex-1' : 'hidden'
        } md:flex ${
          lockOrderScroll || columnMenu ? 'overflow-hidden' : 'overflow-auto'
        }`}
      >
        <div className="mb-3 flex shrink-0 gap-2">
          <input
            placeholder={t(
              hasTables ? 'order.searchMenu' : 'order.searchProductsScan',
            )}
            className="pos-input min-w-0 flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="pos-icon-btn shrink-0"
            onClick={() => {
              const next = menuLayout === 'grid' ? 'column' : 'grid';
              writeMenuLayout(next);
              setMenuLayout(next);
            }}
            title={
              columnMenu ? t('order.menuViewGrid') : t('order.menuViewColumn')
            }
            aria-label={
              columnMenu ? t('order.menuViewGrid') : t('order.menuViewColumn')
            }
            aria-pressed={columnMenu}
          >
            {columnMenu ? <IconGrid /> : <IconList />}
          </button>
        </div>
        <div
          className={
            columnMenu ? 'flex min-h-0 min-w-0 flex-1 gap-2' : 'contents'
          }
        >
          <div
            className={
              columnMenu
                ? 'w-[6.75rem] shrink-0 space-y-1.5 overflow-y-auto overscroll-contain sm:w-[8.75rem] md:w-[10.5rem]'
                : 'mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3'
            }
          >
            {/* Favourites tab */}
            <button
              key={FAVOURITES_CAT_ID}
              onClick={() => setSelectedCatId(FAVOURITES_CAT_ID)}
              className={`${catShape} border border-white/8 hover:bg-gray-800 cursor-pointer ${selected?.id === FAVOURITES_CAT_ID ? 'bg-gray-800' : 'bg-gray-900/70'}`}
            >
              <span className={columnMenu ? 'block truncate' : undefined}>
                {t('order.favourites')}
              </span>
            </button>
            {hasTables ? (
              <button
                key={COMMENTS_CAT_ID}
                onClick={() => setSelectedCatId(COMMENTS_CAT_ID)}
                className={`relative ${catShape} border border-white/8 hover:bg-gray-800 cursor-pointer overflow-hidden ${
                  selected?.id === COMMENTS_CAT_ID
                    ? 'bg-gray-800'
                    : 'bg-gray-900/70'
                }`}
                style={{
                  boxShadow:
                    selected?.id === COMMENTS_CAT_ID
                      ? `inset 0 -3px 0 0 ${COMMENT_TILE_BG}`
                      : `inset 0 -2px 0 0 ${COMMENT_TILE_BG}80`,
                }}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <span
                    className="inline-block w-2.5 h-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: COMMENT_TILE_BG }}
                    aria-hidden
                  />
                  <span className={columnMenu ? 'truncate' : undefined}>
                    {t('order.comments')}
                  </span>
                </span>
              </button>
            ) : null}
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
                  className={`relative ${catShape} border border-white/8 hover:bg-gray-800 cursor-pointer overflow-hidden ${
                    isActive ? 'bg-gray-800' : 'bg-gray-900/70'
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
                  <span className="inline-flex min-w-0 items-center gap-2">
                    {tabColor ? (
                      <span
                        className="inline-block w-2.5 h-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tabColor }}
                        aria-hidden
                      />
                    ) : null}
                    <span className={columnMenu ? 'truncate' : undefined}>
                      {c.name}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div
            className={
              columnMenu
                ? 'grid min-h-0 min-w-0 flex-1 grid-cols-1 items-stretch gap-2 overflow-auto overscroll-contain min-[380px]:grid-cols-2 sm:grid-cols-3'
                : 'grid grid-cols-2 items-stretch gap-2 sm:grid-cols-3'
            }
          >
            {!query.trim() && hasTables && selectedCatId === COMMENTS_CAT_ID ? (
              <>
                {[...commentPresets, ...customCommentButtons].map((phrase) => (
                  <button
                    key={phrase}
                    type="button"
                    className="py-4 rounded text-left px-3 w-full cursor-pointer hover:opacity-90 min-h-[72px] flex items-center"
                    style={menuTileStyle(COMMENT_TILE_BG, uiTheme)}
                    disabled={ticketSyncing || busyAction != null}
                    onClick={() => appendOrderComment(phrase)}
                  >
                    <div className="font-medium leading-snug">{phrase}</div>
                  </button>
                ))}
                <button
                  type="button"
                  className="py-4 rounded text-left px-3 w-full cursor-pointer hover:opacity-90 min-h-[72px] flex items-center font-medium leading-snug"
                  style={{
                    backgroundColor: COMMENT_CUSTOM_BTN_BG,
                    color: '#ffffff',
                  }}
                  disabled={ticketSyncing || busyAction != null}
                  onClick={() => {
                    setCustomCommentInput('');
                    setCustomCommentOpen(true);
                  }}
                >
                  {t('order.writeComment')}
                </button>
              </>
            ) : null}
            {(!query.trim() && selectedCatId === COMMENTS_CAT_ID
              ? []
              : filteredItems
            ).map((i: MenuItemDTO) => {
              const isFav = fav.isFav(user?.id || null, i.sku);
              const isDisabled = menuItemUnavailable(i);
              const isLow = menuItemLowStock(i);
              const stockRem =
                i.stockRemaining != null &&
                Number.isFinite(Number(i.stockRemaining))
                  ? Math.max(0, Math.floor(Number(i.stockRemaining)))
                  : null;
              // Inherit the parent category's colour so the floor sees
              // food and drinks as instantly distinguishable blocks.
              // Light mode lifts that colour to a pastel so tiles match
              // the rest of the till. Disabled items stay a neutral grey.
              const tileStyle = menuTileStyle(
                categoryColorById.get(Number(i.categoryId)) || FALLBACK_TILE_BG,
                uiTheme,
              );
              const unavailableTitle = !i.active
                ? t('order.itemUnavailableInactive')
                : i.stockLevel === 'OUT'
                  ? t('order.outOfStockTitle')
                  : undefined;
              return (
                <div key={i.id} className="relative h-full min-h-[7.25rem]">
                  {isLow ? (
                    <span
                      className="absolute top-1 left-1 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/35 text-amber-400 backdrop-blur-sm border border-amber-500/40 pointer-events-none"
                      title={t('order.lowStockTitle')}
                      aria-hidden
                    >
                      <IconAlert className="h-4 w-4 shrink-0" />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={`h-full min-h-[7.25rem] py-3 rounded text-left px-3 w-full flex flex-col transition-opacity ${
                      isDisabled
                        ? 'bg-gray-800/60 border border-gray-700 text-gray-400 cursor-not-allowed'
                        : 'cursor-pointer hover:opacity-90'
                    }`}
                    style={isDisabled ? undefined : tileStyle}
                    disabled={isDisabled || ticketSyncing || busyAction != null}
                    title={
                      isDisabled
                        ? unavailableTitle
                        : isLow
                          ? stockRem != null
                            ? `${t('order.lowStockTitle')} (${t('order.stockRemainingBadge', { count: stockRem })})`
                            : t('order.lowStockTitle')
                          : i.name
                    }
                    aria-label={
                      isDisabled
                        ? `${i.name}, ${unavailableTitle ?? t('order.unavailableAria')}`
                        : isLow
                          ? stockRem != null
                            ? `${i.name}, ${t('order.lowStockAria')}, ${t('order.stockRemainingBadge', { count: stockRem })}`
                            : `${i.name}, ${t('order.lowStockAria')}`
                          : i.name
                    }
                    onClick={() => {
                      if (isDisabled || ticketSyncing || busyAction != null)
                        return;
                      addMenuItemToSale(i);
                    }}
                  >
                    <div
                      className={`font-medium pr-6 leading-snug line-clamp-3 ${isDisabled ? 'line-through' : ''}`}
                    >
                      {i.name}
                    </div>
                    <div className="mt-auto pt-1">
                      <div className="text-sm tabular-nums">{i.price}</div>
                      {isLow && stockRem != null ? (
                        <div
                          className={`text-[11px] font-semibold mt-0.5 tabular-nums ${
                            uiTheme === 'light'
                              ? 'text-amber-800'
                              : 'text-amber-100/95'
                          }`}
                        >
                          {t('order.stockRemainingBadge', { count: stockRem })}
                        </div>
                      ) : null}
                    </div>
                  </button>
                  <button
                    // Translucent black backdrop so the heart stays
                    // legible on top of any category colour (used to be
                    // hard-coded pink/emerald and looked awful on a red
                    // drinks tile).
                    className={`absolute top-1 right-1 text-xs px-2 py-1 rounded cursor-pointer backdrop-blur-sm ${
                      uiTheme === 'light'
                        ? `bg-black/8 hover:bg-black/14 ${isFav ? 'text-pink-600' : 'text-slate-600'}`
                        : `bg-black/30 hover:bg-black/50 ${isFav ? 'text-pink-300' : 'text-white/90'}`
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
      </div>

      <div
        className={`bg-gray-800/80 p-3 rounded-xl border border-white/8 flex flex-col min-h-0 min-w-0 overflow-hidden h-full ${mobilePane === 'ticket' ? 'flex-1' : 'hidden'} md:flex`}
      >
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="font-semibold flex items-center gap-2 min-w-0">
            <span className="truncate">
              {selectedTable
                ? t(hasTables ? 'order.ticketHeader' : 'order.saleHeader', {
                    label: selectedTable.label,
                  })
                : t(hasTables ? 'order.ticket' : 'order.cart')}
            </span>
            {hasTables &&
              selectedTable &&
              isOpen(selectedTable.area, selectedTable.label) &&
              openedAtMs && (
                <span className="text-xs font-mono px-2 py-1 rounded bg-gray-700/60 border border-gray-600 shrink-0">
                  {formatElapsed(nowMs - openedAtMs)}
                </span>
              )}
          </div>
          {hasTables ? (
            <div
              role="tablist"
              aria-label={t('order.addModeLabel')}
              aria-disabled={isTableOpen}
              className={`inline-flex items-stretch rounded-md border border-white/8 overflow-hidden shrink-0 ${
                isTableOpen ? 'opacity-50' : ''
              }`}
            >
              {ORDER_ADD_MODES.map((mode, i) => {
                const active = addMode === mode;
                const label = t(`order.addMode.${mode}`);
                const title = isTableOpen
                  ? t('order.addModeLockedSent')
                  : label;
                return (
                  <span key={mode} className="flex items-stretch">
                    {i > 0 ? (
                      <span
                        className="w-px shrink-0 self-stretch bg-[var(--pos-hairline)]"
                        aria-hidden
                      />
                    ) : null}
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={title}
                      aria-label={label}
                      disabled={isTableOpen}
                      onClick={() => setAddMode(mode)}
                      className={`pos-icon-btn rounded-none disabled:pointer-events-none disabled:cursor-not-allowed ${
                        active
                          ? 'text-[var(--pos-accent)] bg-[var(--pos-accent-soft)]'
                          : ''
                      }`}
                    >
                      {mode === 'default' ? (
                        <IconOrderDefault className="pos-icon size-5" />
                      ) : mode === 'course' ? (
                        <IconOrderCourse className="pos-icon size-5" />
                      ) : (
                        <IconOrderSeat className="pos-icon size-5" />
                      )}
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {hasTables && canTransfer && (
              <button
                type="button"
                className="bg-indigo-600 hover:bg-indigo-700 px-2.5 py-1.5 rounded border border-indigo-500 text-sm whitespace-nowrap"
                onClick={() => setShowTransfer(true)}
                title={t('order.transferTitle')}
              >
                {t('order.transfer')}
              </button>
            )}
            {hasTables &&
              selectedTable &&
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
                  <IconCovers className="size-4" />
                  <span className="text-sm font-semibold">
                    {typeof coversKnown === 'number' ? coversKnown : '—'}
                  </span>
                </button>
              )}
          </div>
        </div>
        <div
          className={`flex-1 min-h-0 relative ${lockOrderScroll ? 'overflow-hidden' : 'overflow-auto'}`}
        >
          <div className="space-y-2">
            {billUnknown ? (
              <div
                role="alert"
                className="rounded-xl border border-red-500/60 bg-red-500/10 p-3"
              >
                <div className="text-sm font-semibold text-red-200">
                  {t('order.billUnreadable')}
                </div>
                <div className="mt-1 text-[13px] leading-snug text-red-100/80">
                  {t('order.billUnreadableHint')}
                </div>
                <button
                  type="button"
                  className="pos-btn mt-2"
                  onClick={() => setTicketReloadNonce((n) => n + 1)}
                >
                  {t('order.billUnreadableRetry')}
                </button>
              </div>
            ) : null}
            {(() => {
              const renderLine = (l: (typeof lines)[number]) => {
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
                const dimmed = (isTableOpen && !l.staged) || l.paid === true;
                const isVoided = l.voided === true;
                const isPaid = l.paid === true;
                const isSelected = selectedLineId === l.id;
                const canSelect =
                  hasTables &&
                  lineAcceptsComment(l, isTableOpen, showRequestOnly);
                return (
                  <div
                    key={l.id}
                    role="button"
                    tabIndex={canSelect ? 0 : -1}
                    className={`bg-gray-700 rounded px-2 py-2 transition-shadow ${
                      isVoided ? 'opacity-60' : ''
                    } ${
                      isSelected
                        ? 'ring-2 ring-white/40 ring-offset-2 ring-offset-gray-800'
                        : canSelect
                          ? 'cursor-pointer hover:bg-gray-600/80'
                          : ''
                    }`}
                    onClick={() => {
                      if (!canSelect) return;
                      setSelectedLineId((prev) =>
                        prev === l.id ? null : l.id,
                      );
                    }}
                    onKeyDown={(e) => {
                      if (!canSelect) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedLineId((prev) =>
                          prev === l.id ? null : l.id,
                        );
                      }
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                      <div className="min-w-0 flex-1 basis-[7rem]">
                        <div
                          className={`${dimmed ? 'text-gray-400' : 'text-white'} font-medium truncate ${isVoided ? 'line-through decoration-2' : ''}`}
                        >
                          {l.name}
                          {isPaid ? (
                            <span className="ml-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
                              {t('order.seatPaid')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 ml-auto shrink-0">
                        {selectedTable &&
                        isOpen(selectedTable.area, selectedTable.label) &&
                        !showRequestOnly &&
                        l.staged &&
                        !isVoided ? (
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
                              onClick={(e) => {
                                e.stopPropagation();
                                decrement(l.id);
                              }}
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
                              onClick={(e) => {
                                e.stopPropagation();
                                increment(l.id);
                              }}
                              disabled={l.qty >= 100}
                            >
                              +
                            </button>
                          </>
                        ) : (
                          <div
                            className={`w-6 text-center text-gray-400 ${isVoided ? 'line-through decoration-2' : ''}`}
                          >
                            {t('common.qty')}:{l.qty}
                          </div>
                        )}
                        <div
                          className={`min-w-[2.75rem] text-right tabular-nums ${dimmed ? 'text-gray-400' : 'text-white'} ${isVoided ? 'line-through decoration-2' : ''}`}
                        >
                          {l.unitPrice * l.qty}
                        </div>
                        {/* When table is open (sent), owner can void already-sent lines; staged (unsent) lines can be removed */}
                        {selectedTable && isTableOpen && !showRequestOnly ? (
                          isVoided ? (
                            <div className="w-7" aria-hidden />
                          ) : l.staged ? (
                            <button
                              className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                              style={{
                                width: '28px',
                                height: '28px',
                                minWidth: '28px',
                                minHeight: '28px',
                                padding: 0,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeLine(l.id);
                              }}
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
                              disabled={l.paid === true}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (l.paid === true) return;
                                setVoidTarget({
                                  id: l.id,
                                  name: l.name,
                                  qty: l.qty,
                                  unitPrice: l.unitPrice,
                                  vatRate: l.vatRate,
                                  note: l.note,
                                });
                              }}
                              title={
                                l.paid === true
                                  ? t('order.voidBlockedPaid')
                                  : t('order.voidTitle')
                              }
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
                            disabled={
                              (showRequestOnly && !l.staged) || isVoided
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              removeLine(l.id);
                            }}
                          >
                            X
                          </button>
                        )}
                      </div>
                    </div>
                    {hasTables ? (
                      <input
                        className={`mt-2 w-full pos-input px-2 py-1 placeholder:text-gray-300 ${
                          isVoided
                            ? 'bg-gray-700 opacity-60 cursor-not-allowed line-through decoration-2'
                            : dimmed && !(showRequestOnly && l.staged)
                              ? 'bg-gray-700 opacity-60 cursor-not-allowed'
                              : 'bg-gray-600'
                        }`}
                        placeholder={t('order.lineNotePlaceholder')}
                        value={l.note ?? ''}
                        disabled={Boolean(
                          isVoided ||
                            (dimmed && !(showRequestOnly && l.staged)),
                        )}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setLineNote(l.id, e.target.value)}
                      />
                    ) : null}
                  </div>
                );
              };
              if ((addMode === 'course' || addMode === 'seat') && hasTables) {
                return (
                  <TicketCourseBoard
                    mode={addMode === 'seat' ? 'seat' : 'course'}
                    canEdit={!isTableOpen}
                    canAddCourse={isTableOpen}
                    fireDisabled={
                      busyAction != null || !connectionOk || ticketSyncing
                    }
                    printDisabled={
                      busyAction != null || !connectionOk || ticketSyncing
                    }
                    onPrintSeat={
                      addMode === 'seat' && isTableOpen
                        ? (seatId) => {
                            void printSeatBill(seatId);
                          }
                        : undefined
                    }
                    onFireCourse={
                      isTableOpen
                        ? (courseId) => {
                            if (
                              busyAction != null ||
                              ticketSyncing ||
                              !connectionOk ||
                              !selectedTable
                            ) {
                              return;
                            }
                            void (async () => {
                              lastSendAtRef.current = Date.now();
                              lastSendTableRef.current = {
                                area: selectedTable.area,
                                label: selectedTable.label,
                              };
                              setBusyAction('send');
                              try {
                                const lastCovers =
                                  await window.api.covers.getLast(
                                    selectedTable.area,
                                    selectedTable.label,
                                  );
                                await runKitchenFire({
                                  covers: lastCovers ?? null,
                                  courseId,
                                  firstSend: false,
                                  printKitchen: true,
                                });
                              } catch (e: unknown) {
                                const raw = String(
                                  (e as { message?: string })?.message ||
                                    e ||
                                    '',
                                ).trim();
                                toast.error(raw || t('order.toastTryAgain'), {
                                  title: t('order.toastSendFailed'),
                                });
                              } finally {
                                setBusyAction(null);
                              }
                            })();
                          }
                        : undefined
                    }
                    renderLine={renderLine}
                  />
                );
              }
              if (lines.length === 0) {
                return (
                  <div className="text-sm opacity-60">
                    {t('order.selectItems')}
                  </div>
                );
              }
              return lines.map(renderLine);
            })()}
          </div>
        </div>

        {/* Footer pinned at the bottom of the ticket panel as a flex child.
            Was previously `absolute bottom-0` with `pb-80` on the items list,
            which overlapped the last item on narrow viewports. */}
        <div className="shrink-0 mt-3 bg-gray-800 border-t border-gray-700 -mx-3 -mb-3 p-3 rounded-b">
          <div className="space-y-3 text-sm">
            {hasTables ? (
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
                      className={`w-full pos-input px-2 py-2 ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                      rows={2}
                      placeholder={t('order.orderNotesPlaceholder')}
                      value={orderNote}
                      disabled={disabled}
                      onChange={(e) => setOrderNote(e.target.value)}
                    />
                  );
                })()}
              </div>
            ) : null}

            <TicketTotals
              totals={totals}
              vatEnabled={vatEnabled}
              serviceChargeCfg={serviceChargeCfg}
              applyServiceCharge={applyServiceCharge}
              serviceChargeAmount={serviceChargeAmount}
            />

            <div className="flex flex-wrap gap-2">
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
                      className="flex-1 min-w-[8rem] px-2 py-2 text-sm leading-snug text-center bg-amber-700 hover:bg-amber-600 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
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
                      className="flex-1 min-w-[8rem] px-2 py-2 text-sm leading-snug text-center bg-red-600 hover:bg-red-700 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                      disabled={
                        activeLines.length === 0 ||
                        busyAction != null ||
                        !connectionOk ||
                        ticketSyncing ||
                        (isTableOpen && ticketFullySettled)
                      }
                      title={
                        isTableOpen && ticketFullySettled
                          ? t('order.voidBlockedPaid')
                          : undefined
                      }
                      onClick={async () => {
                        if (busyAction != null || ticketSyncing) return;
                        if (isTableOpen && ticketFullySettled) return;
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
                    {hasTables ? (
                      <button
                        className="flex-1 min-w-[8rem] px-2 py-2 text-sm leading-snug text-center bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                        disabled={
                          activeLines.length === 0 ||
                          busyAction != null ||
                          !connectionOk ||
                          ticketSyncing ||
                          billUnknown
                        }
                        onClick={async () => {
                          if (busyAction != null || ticketSyncing) return;
                          if (billUnknown) return;
                          if (!selectedTable) {
                            setPendingAction('send');
                            navigate('/app/tables');
                            return;
                          }
                          // Ask for covers only if table is not marked as open (green)
                          if (
                            !isOpen(selectedTable.area, selectedTable.label)
                          ) {
                            setCoversMode('openAndSend');
                            setCoversValue('');
                            setPrintStationTickets(true);
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
                            if (!user?.id) return;
                            const fired = await runKitchenFire({
                              covers: lastCovers ?? null,
                              firstSend: false,
                              printKitchen: true,
                            });
                            if (!fired.ok) return;
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
                            const isAuth = status === 401;
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
                    ) : null}
                    <button
                      className="flex-1 min-w-[8rem] px-2 py-2 text-sm leading-snug text-center pos-btn-primary cursor-pointer disabled:cursor-not-allowed"
                      disabled={
                        !canPay ||
                        busyAction != null ||
                        !connectionOk ||
                        ticketSyncing ||
                        billUnknown
                      }
                      title={
                        billUnknown
                          ? t('order.billUnreadableHint')
                          : !hasTables
                            ? activeLines.length === 0
                              ? t('order.addItems')
                              : !connectionOk
                                ? t('order.networkWaitPay')
                                : t('order.pay')
                            : !selectedTable
                              ? t('order.selectTable')
                              : activeLines.length === 0
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
                          if (!hasTables) {
                            ensureStoreCounterSelected({
                              hasTables,
                              userId: user?.id,
                              selectedTable,
                              setSelectedTable,
                            });
                            return;
                          }
                          setPendingAction('pay');
                          navigate('/app/tables');
                          return;
                        }
                        if (!connectionOk) {
                          toast.warn(t('order.networkSlow'));
                          return;
                        }
                        await ensureStoreTillOpen();
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
                        if (addMode === 'seat') {
                          const ids = unpaidSeatIds(seats, lines);
                          setPaySeatId(ids[0] ?? null);
                        } else {
                          setPaySeatId(null);
                        }
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
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 overflow-hidden p-3 sm:p-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full sm:w-[92vw] max-w-6xl p-4 flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] relative">
            <div className="flex items-center justify-between mb-3 shrink-0">
              <div>
                <div className="text-lg font-semibold">
                  {t('order.payment')}
                </div>
                {addMode === 'seat' ? (
                  <div className="text-sm text-[var(--pos-accent)]">
                    {payingSeatName
                      ? t('order.payingSeat', { label: payingSeatName })
                      : t('order.paymentBySeat')}
                  </div>
                ) : null}
              </div>
              <button
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={busyAction === 'pay'}
                onClick={() => setShowPayment(false)}
              >
                <IconClose />
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
                  {vatEnabled
                    ? t('order.registeringFiscal')
                    : t('order.processingPaymentOverlay')}
                </div>
                <div className="text-xs opacity-70">
                  {vatEnabled
                    ? t('order.recordingPaymentFiscal')
                    : t('order.recordingPayment')}
                </div>
              </div>
            )}

            {addMode === 'seat' ? (
              <div className="shrink-0 mb-3">
                <div className="text-sm font-medium mb-1.5">
                  {t('order.selectGuestsPayment')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {seatPayRows.map((row) => {
                    const active = paySeatId === row.id;
                    return (
                      <button
                        key={row.id}
                        type="button"
                        disabled={row.paid || busyAction === 'pay'}
                        onClick={() => {
                          setPaySeatId(row.id);
                          setCashTendered('');
                          setDiscountType('NONE');
                          setDiscountValue('');
                        }}
                        className={`min-h-11 min-w-[7.5rem] flex-1 sm:flex-none px-3 py-2 rounded-lg border text-left ${
                          row.paid
                            ? 'opacity-40 cursor-not-allowed border-gray-700 bg-gray-800'
                            : active
                              ? 'border-[var(--pos-accent)] bg-[var(--pos-accent-soft)]'
                              : 'border-gray-600 bg-gray-700 hover:bg-gray-600'
                        }`}
                      >
                        <div className="text-sm font-semibold truncate">
                          {row.label}
                        </div>
                        <div className="text-xs tabular-nums opacity-80">
                          {row.paid
                            ? t('order.seatPaid')
                            : formatAmount(row.gross)}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {unpaidSeatIds(seats, lines).length > 1 ? (
                  <div className="text-xs opacity-70 mt-1.5">
                    {t('order.remainingSeats', {
                      count: unpaidSeatIds(seats, lines).length,
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
              {/* Order summary */}
              <div className="bg-gray-800 rounded-lg p-3 min-h-[280px] flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="text-sm opacity-80">
                      {addMode === 'seat' && payingSeatName
                        ? t('order.orderSummarySeat', {
                            label: payingSeatName,
                          })
                        : t('order.orderSummary')}
                    </div>
                    {hasTables ? (
                      <>
                        <div className="text-sm font-medium">
                          {t('common.table')} {selectedTable.label}
                        </div>
                        <div className="text-xs opacity-70">
                          {t('common.coversWithVal', {
                            val:
                              typeof coversKnown === 'number'
                                ? coversKnown
                                : '—',
                          })}
                        </div>
                      </>
                    ) : (
                      <div className="text-sm font-medium">
                        {t('order.saleHeader', {
                          label: selectedTable.label,
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-auto space-y-1.5 min-h-0">
                  {payLines.length === 0 ? (
                    <div className="text-xs opacity-60">
                      {t('common.noItems')}
                    </div>
                  ) : (
                    payLines.map((l) => (
                      <div
                        key={l.id}
                        className="flex items-start justify-between gap-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="truncate">
                            {l.qty}× {l.name}
                          </div>
                          {l.note ? (
                            <div className="text-[11px] opacity-60 truncate">
                              {l.note}
                            </div>
                          ) : null}
                        </div>
                        <div className="tabular-nums shrink-0 font-medium">
                          {formatAmount(l.qty * l.unitPrice)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-3 pt-3 border-t border-gray-700 space-y-1 text-sm">
                  <div className="flex justify-between opacity-80">
                    <span>{t('common.subtotal')}</span>
                    <span className="tabular-nums">
                      {formatAmount(totals.total)}
                    </span>
                  </div>
                  {serviceChargeCfg.enabled && serviceChargeAmount > 0 ? (
                    <div className="flex justify-between opacity-80">
                      <span>{t('common.serviceCharge')}</span>
                      <span className="tabular-nums">
                        + {formatAmount(serviceChargeAmount)}
                      </span>
                    </div>
                  ) : null}
                  {discountAmount > 0 ? (
                    <div className="flex justify-between opacity-80">
                      <span>{t('common.discount')}</span>
                      <span className="tabular-nums">
                        − {formatAmount(discountAmount)}
                      </span>
                    </div>
                  ) : null}
                  <div className="flex justify-between font-semibold pt-1">
                    <span>{t('common.total')}</span>
                    <span className="tabular-nums">
                      {formatAmount(totalDue)}
                    </span>
                  </div>
                  <PaymentFxHint
                    eurAmount={eurDue}
                    eurExchangeRate={eurExchangeRate}
                    showRate
                  />
                </div>
                {addMode !== 'seat' ? (
                  <div className="mt-3 p-3 rounded bg-gray-900/40 border border-gray-700">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium">
                        {t('order.splitBill')}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="h-11 w-11 rounded bg-gray-700 hover:bg-gray-600 text-lg leading-none disabled:opacity-40"
                          disabled={splitGuestCount <= 1}
                          onClick={() =>
                            setSplitGuestCount((n) => Math.max(1, n - 1))
                          }
                          aria-label="−"
                        >
                          −
                        </button>
                        <div className="min-w-[2rem] text-center font-semibold tabular-nums">
                          {splitGuestCount}
                        </div>
                        <button
                          type="button"
                          className="h-11 w-11 rounded bg-gray-700 hover:bg-gray-600 text-lg leading-none disabled:opacity-40"
                          disabled={splitGuestCount >= 30}
                          onClick={() =>
                            setSplitGuestCount((n) => Math.min(30, n + 1))
                          }
                          aria-label="+"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    {split ? (
                      <div>
                        <div className="text-sm font-semibold tabular-nums">
                          {split.guests > 1 &&
                          Math.abs(split.lastPerson - split.perPerson) > 0.001
                            ? t('order.perPersonLast', {
                                amount: formatAmount(split.perPerson),
                                last: formatAmount(split.lastPerson),
                              })
                            : t('order.perPerson', {
                                amount: formatAmount(split.perPerson),
                              })}
                        </div>
                        <PaymentFxHint
                          eurAmount={eurPerPerson}
                          eurExchangeRate={eurExchangeRate}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
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
                <div className="flex items-start justify-between mb-3 gap-2">
                  <div className="text-sm opacity-80 flex items-center gap-2">
                    <IconReceipt />
                    {t('order.paymentAmount')}
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold tabular-nums leading-tight">
                      {formatAmount(totalDue)}
                    </div>
                    <PaymentFxHint
                      eurAmount={eurDue}
                      eurExchangeRate={eurExchangeRate}
                    />
                  </div>
                </div>
                {paymentMethod === 'CASH' && (
                  <div className="mb-3 p-3 rounded bg-gray-900/40 border border-gray-700">
                    <div className="text-sm font-medium mb-2">
                      {t('order.cashReceived')}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {cashSuggestions.map((amt) => (
                        <button
                          key={amt}
                          type="button"
                          className={`min-h-11 px-3 py-2 rounded text-sm tabular-nums ${
                            Number.isFinite(cashTenderedNum) &&
                            Math.abs(cashTenderedNum - amt) < 1e-9
                              ? 'bg-blue-600'
                              : 'bg-gray-700 hover:bg-gray-600'
                          }`}
                          onClick={() => setCashTendered(String(amt))}
                        >
                          {Math.abs(amt - totalDue) < 1e-9
                            ? t('order.exactAmount')
                            : formatAmount(amt)}
                        </button>
                      ))}
                    </div>
                    <input
                      className="w-full bg-gray-700 rounded px-3 py-3 text-base tabular-nums"
                      inputMode="decimal"
                      placeholder={t('order.cashReceivedPlaceholder')}
                      value={cashTendered}
                      onChange={(e) => setCashTendered(e.target.value)}
                    />
                    <div className="mt-2 flex justify-between text-sm">
                      <span className="opacity-70">{t('order.changeDue')}</span>
                      <span className="font-semibold tabular-nums">
                        {formatAmount(cashChange)}
                      </span>
                    </div>
                  </div>
                )}
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
                    className="pos-btn-primary w-full py-4 text-[15px] disabled:cursor-not-allowed"
                    disabled={
                      busyAction != null ||
                      !connectionOk ||
                      payLines.length === 0
                    }
                    onClick={async () => {
                      if (busyAction != null) return;
                      if (!connectionOk) return;
                      setBusyAction('pay');
                      await ensureStoreTillOpen();
                      // Close the table only after the host accepted the
                      // payment. Fiscal refusals and "could not reach till"
                      // keep the sitting open. The host also closes the
                      // table as part of a successful PAYMENT so two
                      // waiters cannot fiscalize the same sitting.
                      let paymentAccepted = false;
                      let closeTableAfterPay = true;
                      let paidLineIds: string[] = [];
                      let paidSeatLabel: string | undefined;
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
                        const items = payLines.map((l) => ({
                          sku: l.sku,
                          name: l.name,
                          qty: l.qty,
                          unitPrice: l.unitPrice,
                          vatRate: l.vatRate,
                          note: l.note,
                          station: (l as any).station,
                          categoryId: (l as any).categoryId,
                          categoryName: (l as any).categoryName,
                          courseId: (l as any).courseId || null,
                          seatId: (l as any).seatId || null,
                        }));
                        const payingIds = payLines.map((l) => l.id);
                        const closeTable =
                          addMode !== 'seat' ||
                          shouldCloseTableAfterSeatPay(lines, payingIds);
                        closeTableAfterPay = closeTable;
                        paidLineIds = payingIds;
                        const payingSeatLabel =
                          addMode === 'seat' && paySeatId
                            ? seatLabel(
                                seats,
                                paySeatId,
                                t('order.seatN', {
                                  n: seatNumber(seats, paySeatId) || 1,
                                }),
                              )
                            : undefined;
                        paidSeatLabel = payingSeatLabel;
                        const paymentIdempotencyKey = newIdempotencyKey();
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
                        // Fiscal refusals throw. After the host records
                        // the sale, a down printer returns `{ ok: true,
                        // printed: false }` and we still close the table.
                        try {
                          const payResult = await tryOrQueue(
                            'payments.record',
                            {
                              area: selectedTable.area,
                              tableLabel: selectedTable.label,
                              covers: lastCovers ?? null,
                              items,
                              note: hasTables ? orderNote || null : null,
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
                                closeTable,
                                seatLabel: payingSeatLabel,
                                seatId: paySeatId || undefined,
                              },
                            },
                          );
                          if (payResult.queued) {
                            // Host never confirmed the sale. With fiskalizimi
                            // on, closing now would free the table before an
                            // invoice exists.
                            toast.error(t('order.paymentNeedsTill'), {
                              title: t('order.paymentBlocked'),
                            });
                          } else {
                            paymentAccepted = true;
                            const printed = (payResult.result as any)?.printed;
                            if (printed === false) {
                              toast.warn(t('order.paymentRecordedPrintQueued'));
                            }
                          }
                        } catch (e: any) {
                          if (String(e?.code || '') === 'TABLE_ALREADY_PAID') {
                            toast.info(t('order.alreadyPaid'));
                            paymentAccepted = true;
                          } else {
                            const detail = String(e?.message || '').trim();
                            toast.error(
                              detail || t('order.paymentNotRecorded'),
                              {
                                title: t('order.paymentBlocked'),
                              },
                            );
                          }
                        }
                      } finally {
                        // Close only when the host accepted the sale (or
                        // another waiter already settled this sitting).
                        if (paymentAccepted) {
                          if (paidLineIds.length) {
                            markLinesAsPaid(paidLineIds);
                          }
                          if (user?.id && addMode === 'seat') {
                            const snapshot = useTicketStore
                              .getState()
                              .lines.map((l) => toTicketLogLine(l));
                            await logTicket({
                              userId: user.id,
                              area: selectedTable.area,
                              tableLabel: selectedTable.label,
                              covers:
                                typeof coversKnown === 'number'
                                  ? coversKnown
                                  : null,
                              items: snapshot,
                              note: orderNote || undefined,
                              stockConsumeLines: [],
                              kdsFireItems: [],
                            }).catch(() => {});
                          }
                          if (closeTableAfterPay) {
                            setOpen(
                              selectedTable.area,
                              selectedTable.label,
                              false,
                            );
                            invalidateFloorCache();
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
                          } else {
                            const nextIds = unpaidSeatIds(
                              useTicketStore.getState().seats,
                              useTicketStore.getState().lines,
                            );
                            setPaySeatId(nextIds[0] ?? null);
                            setCashTendered('');
                            setDiscountType('NONE');
                            setDiscountValue('');
                            toast.success(
                              t('order.seatPaidToast', {
                                label: paidSeatLabel || t('order.addMode.seat'),
                              }),
                            );
                          }
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
                        <span>
                          {vatEnabled
                            ? t('order.registeringFiscal')
                            : t('order.processingPaymentOverlay')}
                        </span>
                      </>
                    ) : (
                      <span className="flex flex-col items-center leading-tight">
                        <span>
                          {addMode === 'seat' && payingSeatName
                            ? t('order.paySeatWithTotal', {
                                label: payingSeatName,
                                amount: formatAmount(totalDue),
                              })
                            : t('order.payWithTotal', {
                                amount: formatAmount(totalDue),
                              })}
                        </span>
                        {eurDue != null ? (
                          <span className="text-xs font-medium opacity-90">
                            {formatEur(eurDue)}
                          </span>
                        ) : null}
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
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setShowTransfer(false)}
              >
                <IconClose />
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
                className="flex-1 pos-btn-primary py-2"
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
                    const transferIdempotencyKey = newIdempotencyKey();
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
                    const transferResult = await tryOrQueue(
                      'tables.transfer',
                      payload,
                      {
                        dedupeKey: `tables.transfer:${selectedTable.area}:${selectedTable.label}`,
                      },
                    );
                    if (transferResult.queued) {
                      toast.info(t('order.transferQueued'), {
                        title: t('common.syncingQueued'),
                      });
                      setShowTransfer(false);
                      return;
                    }
                    const r: any = transferResult.result;
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
                      invalidateTicketCache(
                        selectedTable.area,
                        selectedTable.label,
                      );
                      invalidateTicketCache(toA, toL);
                      invalidateFloorCache();
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
                      void refreshTableOwner(toA, toL, latest?.userId ?? null);
                    } else if (
                      transferMode === 'WAITER' &&
                      transferToUserId != null
                    ) {
                      // Same table, new owner — flip to request-only now,
                      // do not wait for a refresh or the next owner poll.
                      void refreshTableOwner(
                        selectedTable.area,
                        selectedTable.label,
                        transferToUserId,
                      );
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
            {coversMode === 'openAndSend' ? (
              <div className="flex items-center justify-between mt-4">
                <div className="flex items-center gap-2">
                  <IconPrinter />
                  <span className="text-sm">
                    {t('order.printStationTickets')}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={printStationTickets}
                  className={`relative h-8 w-14 shrink-0 rounded-full transition-colors duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
                    printStationTickets ? 'bg-blue-600' : 'bg-gray-700'
                  }`}
                  onClick={() => setPrintStationTickets((v) => !v)}
                  aria-label={t('order.togglePrintStationTickets')}
                >
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute top-1/2 size-[1.375rem] -translate-y-1/2 rounded-full bg-white shadow-md ring-1 ring-black/15 transition-[left] duration-200 ease-out ${
                      printStationTickets
                        ? 'left-[calc(100%-1.375rem-5px)]'
                        : 'left-[5px]'
                    }`}
                  />
                </button>
              </div>
            ) : null}
            <div className="flex gap-2 mt-4">
              <button
                className="flex-1 bg-gray-600 py-2 rounded"
                onClick={() => setShowCovers(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="flex-1 pos-btn-primary py-2 disabled:cursor-not-allowed"
                disabled={busyAction != null}
                onClick={async () => {
                  if (busyAction != null) return;
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
                  setBusyAction('send');
                  try {
                    lastSendAtRef.current = Date.now();
                    lastSendTableRef.current = {
                      area: selectedTable.area,
                      label: selectedTable.label,
                    };
                    // Pin the sit open before IPC: SSE can mark the table
                    // occupied (and trigger hydrate/empty-close) before
                    // covers.save returns, which used to free it again.
                    suppressFreeOnEmptyRef.current = true;
                    setCoversKnown(num);
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
                    if (!user?.id) return;
                    const fired = await runKitchenFire({
                      covers: num,
                      firstSend: true,
                      printKitchen: printStationTickets,
                    });
                    if (!fired.ok) return;
                    // Keep this as a best-effort "ensure open" after printing.
                    await window.api.tables
                      .setOpen(selectedTable.area, selectedTable.label, true)
                      .catch(() => {});
                  } finally {
                    setBusyAction(null);
                    suppressFreeOnEmptyRef.current = false;
                  }
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
                    // Optimistically mark the voided line immediately
                    markLineVoided(vt.id);
                    // Re-sync ticket from server to ensure consistency
                    const latest = await window.api.tickets
                      .getLatestForTable(
                        selectedTable.area,
                        selectedTable.label,
                      )
                      .catch(() => null as any);
                    const allItems = ((latest?.items as any[]) || []) as any[];
                    useTicketStore.getState().hydrate({
                      items: allItems as any,
                      note: latest?.note || '',
                    });
                    if (activeTicketItems(allItems).length === 0) {
                      // All items voided → free the table
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

      {customCommentOpen && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => setCustomCommentOpen(false)}
        >
          <div
            className="bg-gray-800 p-5 rounded w-full max-w-sm border border-gray-700"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-center mb-3 font-semibold">
              {t('order.writeComment')}
            </h3>
            <textarea
              ref={customCommentInputRef}
              className="w-full bg-gray-700 rounded px-3 py-2 text-sm mb-3 min-h-[80px] resize-y placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/50"
              placeholder={t('order.writeCommentPlaceholder')}
              value={customCommentInput}
              autoFocus
              onChange={(e) => setCustomCommentInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const text = customCommentInput.trim();
                  if (!text) return;
                  appendCustomCommentButton(text);
                  setCustomCommentInput('');
                  customCommentInputRef.current?.focus();
                }
              }}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 inline-flex items-center justify-center gap-1.5 bg-gray-600 hover:bg-gray-500 py-2 rounded"
                onClick={() => setCustomCommentOpen(false)}
              >
                <IconClose />
                {t('common.close')}
              </button>
              <button
                type="button"
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded font-medium"
                onClick={() => {
                  const text = customCommentInput.trim();
                  if (!text) return;
                  appendCustomCommentButton(text);
                  setCustomCommentInput('');
                  customCommentInputRef.current?.focus();
                }}
              >
                {t('order.writeCommentAdd')}
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
                className={`flex-1 py-2 rounded ${
                  weightUnit === 'kg'
                    ? 'bg-emerald-600'
                    : 'bg-gray-700 hover:bg-gray-600'
                }`}
                onClick={() => setWeightUnit('kg')}
              >
                kg
              </button>
              <button
                className={`flex-1 py-2 rounded ${
                  weightUnit === 'g'
                    ? 'bg-emerald-600'
                    : 'bg-gray-700 hover:bg-gray-600'
                }`}
                onClick={() => setWeightUnit('g')}
              >
                g
              </button>
            </div>
            <input
              className="w-full bg-gray-700 rounded px-2 py-2 text-center mb-3"
              placeholder={t('order.weightPlaceholder')}
              inputMode="decimal"
              value={weightInput ? `${weightInput} ${weightUnit}` : ''}
              onChange={(e) => {
                // Keep only the numeric part; the unit is chosen via kg/g.
                const digits = e.target.value
                  .replace(/[^0-9.]/g, '')
                  .replace(/(\..*)\./g, '$1');
                setWeightInput(digits);
              }}
            />
            <div className="flex gap-2">
              <button
                className="flex-1 bg-gray-600 py-2 rounded"
                onClick={() => {
                  setWeightModal(null);
                  setWeightInput('');
                  setWeightUnit('kg');
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded"
                onClick={() => {
                  if (!weightModal) return;
                  const amount = Number(weightInput.trim());
                  if (!Number.isFinite(amount) || amount <= 0) return;
                  const qty = weightUnit === 'g' ? amount / 1000 : amount;
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
                    courseId:
                      addMode === 'course' &&
                      (weightModal as any).station !== 'BAR'
                        ? activeCourseId
                        : null,
                    seatId: addMode === 'seat' ? activeSeatId : null,
                  } as any);
                  setWeightModal(null);
                  setWeightInput('');
                  setWeightUnit('kg');
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
                    status === 401
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
                      status === 401
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
function PaymentFxHint({
  eurAmount,
  eurExchangeRate,
  showRate = false,
}: {
  eurAmount: number | null;
  eurExchangeRate: number | null;
  showRate?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-0.5">
      {eurAmount != null ? (
        <div className="text-sm font-medium text-emerald-300 tabular-nums">
          {t('order.inEur', { amount: formatEur(eurAmount) })}
        </div>
      ) : showRate ? (
        <div className="text-[11px] opacity-50">
          {t('order.eurRateMissing')}
        </div>
      ) : null}
      {showRate && eurExchangeRate != null ? (
        <div className="text-[11px] opacity-50">
          {t('order.eurRateHint', { rate: String(eurExchangeRate) })}
        </div>
      ) : null}
    </div>
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

/**
 * Display totals for the open ticket.
 *
 * Delegates to the shared helpers so the cashier's figures are produced
 * by the same code the host uses to recompute the payment. These are
 * still a display value — `tickets:print` recomputes authoritatively —
 * but keeping one implementation means the two agree.
 */
function computeTotals(
  lines: Array<{ unitPrice: number; qty: number; vatRate: number }>,
  vatEnabled = true,
  defaultVatRate = 0,
) {
  const { net, vat } = sumTicketLinesNetVat(lines, vatEnabled, defaultVatRate);
  const subtotal = roundMoney(net);
  const vatAmount = roundMoney(vat);
  return { subtotal, vat: vatAmount, total: roundMoney(subtotal + vatAmount) };
}

// makeFormatAmount imported from utils/format
