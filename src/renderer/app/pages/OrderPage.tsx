import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useTicketStore,
  toTicketLogLine,
  type TicketLine,
  type TicketLogItem,
} from '../../stores/ticket';
import { TicketLineRow } from '../components/TicketLineRow';
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
import { restoreMissingServerLines } from '@shared/ticketDraft';
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
import { makeFormatAmount } from '../../utils/format';
import { toast } from '../../stores/toasts';
import { reportAppError } from '../../utils/reportAppError';
import { PageSpinner } from '../../components/PageSpinner';
import { Modal } from '../../components/ui/Modal';
import { PaymentCheckout } from '../components/PaymentCheckout';
import { retryLazyImport } from '../../utils/lazyRetry';
import { menuItemSoldByKg, withSoldByKgFlags } from '@shared/menuItemKg';
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
  IconChevronLeft,
  IconClose,
  IconCovers,
  IconEdit,
  IconGrid,
  IconHeart,
  IconList,
  IconOrderCourse,
  IconOrderDefault,
  IconOrderSeat,
  IconPrinter,
  IconSearch,
  IconTrash,
  IconMoveRight,
} from '../../components/icons';
import { isSseHealthy, pollIntervalMs } from '../../utils/netQuality';
import { usePosUiTheme } from '../../theme';
import { FALLBACK_MENU_TILE_BG, menuTileStyle } from '@shared/menuTileColor';
import type { PosUiTheme } from '@shared/uiTheme';
import {
  invalidateFloorCache,
  invalidateTicketCache,
  peekFloorSnapshot,
  peekMenu,
} from '../../utils/posReadCache';
import { readTicketForTable } from '../../utils/ticketRead';
import {
  decideHostBill,
  peekTableBill,
  peekTableBillTotal,
} from '../../utils/tableBill';
import { applyHostOpenTables } from '../../utils/openTablesSync';
import { hasLocalCovers } from '../../utils/tableSessionKeepOpen';

function loadTicketCourseBoard() {
  return retryLazyImport(() =>
    import('../components/TicketCourseBoard').then((m) => ({
      default: m.TicketCourseBoard,
    })),
  );
}

const TicketCourseBoard = lazy(loadTicketCourseBoard);

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

function CategorySwatch({ color }: { color: string }) {
  return (
    <span className="pos-menu-cat-mark" aria-hidden>
      <span className="pos-menu-cat-dot" style={{ backgroundColor: color }} />
    </span>
  );
}

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

const MenuItemTile = memo(function MenuItemTile({
  item,
  isFav,
  locked,
  uiTheme,
  categoryColor,
  qty = 0,
  showQtyBubble = false,
  labels,
  onAdd,
  onToggleFav,
}: {
  item: MenuItemDTO;
  isFav: boolean;
  locked: boolean;
  uiTheme: PosUiTheme;
  categoryColor: string | null | undefined;
  qty?: number;
  showQtyBubble?: boolean;
  labels: {
    inactive: string;
    out: string;
    unavailable: string;
    lowTitle: string;
    lowAria: string;
    remaining: (count: number) => string;
    favAdd: string;
    favRemove: string;
  };
  onAdd: (item: MenuItemDTO) => void;
  onToggleFav: (sku: string) => void;
}) {
  const isDisabled = menuItemUnavailable(item);
  const isLow = menuItemLowStock(item);
  const stockRem =
    item.stockRemaining != null && Number.isFinite(Number(item.stockRemaining))
      ? Math.max(0, Math.floor(Number(item.stockRemaining)))
      : null;
  const tileStyle = menuTileStyle(categoryColor || FALLBACK_TILE_BG, uiTheme);
  const unavailableTitle = !item.active
    ? labels.inactive
    : item.stockLevel === 'OUT'
      ? labels.out
      : undefined;
  const qtyShown =
    showQtyBubble && qty > 0 ? (qty > 99 ? '99+' : String(qty)) : null;
  return (
    <div className="relative min-h-0 h-full">
      {isLow ? (
        <span
          className="absolute top-1 left-1 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/35 text-amber-400 backdrop-blur-sm border border-amber-500/40 pointer-events-none"
          title={labels.lowTitle}
          aria-hidden
        >
          <IconAlert className="h-4 w-4 shrink-0" />
        </span>
      ) : null}
      {qtyShown ? (
        <span className="pos-menu-qty" aria-hidden>
          {qtyShown}
        </span>
      ) : null}
      <button
        type="button"
        className={`pos-menu-tile ${
          isDisabled ? 'pos-menu-tile--disabled' : 'cursor-pointer'
        }`}
        style={isDisabled ? undefined : tileStyle}
        disabled={isDisabled || locked}
        title={
          isDisabled
            ? unavailableTitle
            : isLow
              ? stockRem != null
                ? `${labels.lowTitle} (${labels.remaining(stockRem)})`
                : labels.lowTitle
              : item.name
        }
        aria-label={
          isDisabled
            ? `${item.name}, ${unavailableTitle ?? labels.unavailable}`
            : [
                item.name,
                qtyShown ? `×${qtyShown}` : null,
                isLow
                  ? stockRem != null
                    ? `${labels.lowAria}, ${labels.remaining(stockRem)}`
                    : labels.lowAria
                  : null,
              ]
                .filter(Boolean)
                .join(', ')
        }
        onClick={() => {
          if (isDisabled || locked) return;
          onAdd(item);
        }}
      >
        <div
          className={`font-medium pr-9 leading-snug line-clamp-3 ${isDisabled ? 'line-through' : ''}`}
        >
          {item.name}
        </div>
        <div className="mt-auto pt-1">
          <div className="text-sm tabular-nums">{item.price}</div>
          {isLow && stockRem != null ? (
            <div
              className={`text-[11px] font-semibold mt-0.5 tabular-nums ${
                uiTheme === 'light' ? 'text-amber-800' : 'text-amber-100/95'
              }`}
            >
              {labels.remaining(stockRem)}
            </div>
          ) : null}
        </div>
      </button>
      <button
        type="button"
        className={`pos-menu-fav absolute top-1.5 right-1.5 z-10 ${
          isFav ? 'pos-menu-fav--on' : ''
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFav(item.sku);
        }}
        title={isFav ? labels.favRemove : labels.favAdd}
        aria-label={isFav ? labels.favRemove : labels.favAdd}
        aria-pressed={isFav}
      >
        <IconHeart className={`size-3.5 ${isFav ? 'fill-current' : ''}`} />
      </button>
    </div>
  );
});

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

/** Do not hold Send on a hung ticket GET — local lines still go to the kitchen. */
const LIVE_TICKET_BUDGET_MS = 2_000;

function raceWithBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * The host's copy of this sitting's ticket, read past the SWR cache so a
 * stale entry cannot resurrect a line that was just voided. Failing to read
 * must not block a send, so an unreachable host answers "nothing".
 */
function ownerIdFromFloorCache(area: string, label: string): number | null {
  const snap = peekFloorSnapshot(area);
  const row = snap?.tables?.find((t) => t.area === area && t.label === label);
  const uid = Number(row?.userId);
  return Number.isFinite(uid) && uid > 0 ? uid : null;
}

async function liveServerTicketLines(
  area: string,
  label: string,
): Promise<TicketLogItem[]> {
  try {
    invalidateTicketCache(area, label);
    const read = await raceWithBudget(
      readTicketForTable(area, label),
      LIVE_TICKET_BUDGET_MS,
    );
    if (!read?.ok) return [];
    return read.items as TicketLogItem[];
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
const MENU_CAT_GRID_WIDE = '(min-width: 640px)';
const MENU_ITEM_GRID_MID = '(min-width: 380px)';
/** Same breakpoint as `md:` — two-pane order layout vs phone stack. */
const ORDER_TWO_PANE = '(min-width: 768px)';
type MenuLayout = 'grid' | 'column';

function documentHidden(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  );
}

/**
 * How long until the next background refresh.
 *
 * This screen runs several independent loops (occupancy, table owner, approved
 * requests) and they all used a flat 4s. On a phone that is roughly one
 * request per second on top of SSE, which is enough to push reads past their
 * timeout — and a timeout is what flips `isLinkDegraded()` and makes
 * everything slower still. SSE already delivers these changes, so when the
 * socket is healthy the polls exist only as a safety net and can be rare.
 * Mirrors what `TablesPage` already does for the floor snapshot.
 */
function backgroundPollMs(baseMs = 4000): number {
  const hidden = documentHidden();
  if (isSseHealthy() && !hidden) return 20_000;
  return pollIntervalMs(baseMs, hidden);
}

function catGridPadCount(tileCount: number, cols: number): number {
  if (cols < 2 || tileCount < 1) return 0;
  const rem = tileCount % cols;
  return rem === 0 ? 0 : cols - rem;
}

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
  const [catGridWide, setCatGridWide] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia(MENU_CAT_GRID_WIDE).matches
      : true,
  );
  const [itemGridMid, setItemGridMid] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia(MENU_ITEM_GRID_MID).matches
      : true,
  );
  const [twoPane, setTwoPane] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia(ORDER_TWO_PANE).matches
      : true,
  );
  useEffect(() => {
    const catMq = window.matchMedia(MENU_CAT_GRID_WIDE);
    const itemMq = window.matchMedia(MENU_ITEM_GRID_MID);
    const paneMq = window.matchMedia(ORDER_TWO_PANE);
    const apply = () => {
      setCatGridWide(catMq.matches);
      setItemGridMid(itemMq.matches);
      setTwoPane(paneMq.matches);
    };
    apply();
    catMq.addEventListener('change', apply);
    itemMq.addEventListener('change', apply);
    paneMq.addEventListener('change', apply);
    return () => {
      catMq.removeEventListener('change', apply);
      itemMq.removeEventListener('change', apply);
      paneMq.removeEventListener('change', apply);
    };
  }, []);
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
  } = useTicketStore(
    useShallow((s) => ({
      lines: s.lines,
      addItem: s.addItem,
      increment: s.increment,
      decrement: s.decrement,
      setLineNote: s.setLineNote,
      orderNote: s.orderNote,
      setOrderNote: s.setOrderNote,
      clear: s.clear,
      removeLine: s.removeLine,
      markLineVoided: s.markLineVoided,
      activeCourseId: s.activeCourseId,
      addMode: s.addMode,
      setAddMode: s.setAddMode,
      bindTable: s.bindTable,
      hasHydrated: s.hasHydrated,
      seats: s.seats,
      activeSeatId: s.activeSeatId,
      markLinesAsPaid: s.markLinesAsPaid,
    })),
  );
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
  const [showOrderNote, setShowOrderNote] = useState(false);
  const { selectedTable, setPendingAction, setSelectedTable } =
    useOrderContext();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const uiTheme = usePosUiTheme();
  const { setOpen, isOpen } = useTableStatus();
  const [openLoaded, setOpenLoaded] = useState(
    () => Object.keys(useTableStatus.getState().openMap).length > 0,
  );

  useEffect(() => {
    if (!ticketPersistReady) return;
    const key = selectedTable
      ? tableKey(selectedTable.area, selectedTable.label)
      : null;
    bindTable(key, {
      keepLiveBill: Boolean(
        openLoaded &&
          selectedTable &&
          isOpen(selectedTable.area, selectedTable.label),
      ),
    });
  }, [
    ticketPersistReady,
    bindTable,
    openLoaded,
    selectedTable?.area,
    selectedTable?.label,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
  ]);
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

  useEffect(() => {
    if (!(twoPane || mobilePane === 'ticket')) return;
    void loadTicketCourseBoard();
  }, [twoPane, mobilePane]);

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
  const showRequestOnly = Boolean(
    isTableOpen &&
      ownerId &&
      user?.id != null &&
      Number(ownerId) !== Number(user.id),
  );
  /**
   * An occupied table whose bill we could not read. Sending or paying now
   * would act on a check we cannot see, so both are held until a retry
   * succeeds.
   */
  const billUnknown = isTableOpen && ticketLoadFailed;
  const activeLines = useMemo(() => lines.filter((l) => !l.voided), [lines]);
  // Menu-tile bubbles are a waiter cue for *this* send, not the whole bill.
  // After kitchen fire, lines stay on the ticket with staged=false — counting
  // them would leave the old badges up and confuse a second round of items.
  const qtyBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of activeLines) {
      if (l.staged !== true) continue;
      const sku = String(l.sku || '').trim();
      if (!sku) continue;
      const q = Number(l.qty || 0);
      if (!Number.isFinite(q) || q <= 0) continue;
      m.set(sku, (m.get(sku) || 0) + q);
    }
    return m;
  }, [activeLines]);
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
    // Show the table as open before touching the network, then let the queue
    // deliver both writes in the background. Awaiting them here meant the
    // waiter could not start ordering until the host answered, which on a slow
    // LAN left the screen unresponsive for as long as the transport timeout.
    setOpen(selectedTable.area, selectedTable.label, true);
    void tryOrQueue(
      'tables.setOpen',
      {
        area: selectedTable.area,
        label: selectedTable.label,
        open: true,
      },
      {
        dedupeKey: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
      },
    ).catch((e: unknown) => {
      reportAppError(e, {
        fallback: t('order.toastTryAgain'),
        key: 'tables.setOpen',
      });
    });
    void tryOrQueue(
      'covers.save',
      {
        area: selectedTable.area,
        label: selectedTable.label,
        covers: 1,
      },
      {
        dedupeKey: `covers.save:${selectedTable.area}:${selectedTable.label}`,
      },
    ).catch((e: unknown) => {
      reportAppError(e, {
        fallback: t('order.toastTryAgain'),
        key: 'covers.save',
      });
    });
  }, [hasTables, selectedTable, isOpen, setOpen, t]);

  // Ensure table open/occupied status is loaded even when user refreshes on OrderPage.
  // Reset on mount so the loading screen shows until fresh data arrives.
  const orderPollGenRef = useRef(0);
  useEffect(() => {
    const gen = ++orderPollGenRef.current;
    let timer: any;
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        if (documentHidden()) {
          if (!cancelled && gen === orderPollGenRef.current)
            setOpenLoaded(true);
          return;
        }
        const open = await window.api.tables.listOpen();
        if (cancelled || gen !== orderPollGenRef.current) return;
        if (Array.isArray(open)) applyHostOpenTables(open);
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
      try {
        if (documentHidden()) return;
        const open = await window.api.tables.listOpen();
        if (cancelled || gen !== orderPollGenRef.current) return;
        if (Array.isArray(open)) applyHostOpenTables(open);
      } catch {
        // ignore poll errors
      } finally {
        if (!cancelled && gen === orderPollGenRef.current) {
          timer = setTimeout(poll, backgroundPollMs());
        }
      }
    };
    fetchOnce().then(() => {
      if (!cancelled && gen === orderPollGenRef.current) {
        timer = setTimeout(poll, backgroundPollMs());
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

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

  const coversKnownRef = useRef(coversKnown);
  coversKnownRef.current = coversKnown;

  // Freeing a table MUST go through the queue, even though this path is only
  // ever reached for a table we already believe is empty. `tables.setOpen` is
  // a durable op that retries until it lands, and the only thing that retires
  // a superseded write is `tryOrQueue`'s dedupe key. Calling the API directly
  // here left the `{ open: true }` from the covers dialog on the queue, so
  // minutes after the sitting was freed the replay re-occupied the table.
  const closeOccupiedTable = useCallback(
    (area: string, label: string) => {
      invalidateTicketCache(area, label);
      setOpen(area, label, false);
      void tryOrQueue(
        'tables.setOpen',
        { area, label, open: false },
        { dedupeKey: `tables.setOpen:${area}:${label}` },
      ).catch((e: unknown) => {
        reportAppError(e, {
          fallback: t('order.toastTryAgain'),
          key: `tables.setOpen:${area}:${label}`,
        });
        setOpen(area, label, true);
      });
    },
    [setOpen, t],
  );

  const applyHostBill = useCallback(
    (
      read: Awaited<ReturnType<typeof readTicketForTable>>,
      opts: {
        mayCloseTable: boolean;
        hasCovers: boolean;
        area: string;
        label: string;
      },
    ) => {
      const currentLines = useTicketStore.getState().lines;
      const sentTable = lastSendTableRef.current;
      const withinPostSendGrace =
        currentLines.length > 0 &&
        Date.now() - lastSendAtRef.current < 5000 &&
        Boolean(
          sentTable &&
            sentTable.area === opts.area &&
            sentTable.label === opts.label,
        );
      const decision = decideHostBill({
        read,
        currentLines,
        hasCovers: opts.hasCovers,
        suppressClose: suppressFreeOnEmptyRef.current,
        withinPostSendGrace,
        expectedTotal: peekTableBillTotal(opts.area, opts.label),
      });
      if (decision.kind === 'unreadable') {
        setTicketLoadFailed(true);
        return;
      }
      setTicketLoadFailed(false);
      if (decision.kind === 'hydrate' || decision.kind === 'voided') {
        useTicketStore
          .getState()
          .hydrate({ items: decision.items as any, note: decision.note });
        if (
          decision.kind === 'voided' &&
          opts.mayCloseTable &&
          !suppressFreeOnEmptyRef.current
        ) {
          closeOccupiedTable(opts.area, opts.label);
        }
        return;
      }
      if (decision.kind === 'keep') return;
      if (opts.mayCloseTable) {
        useTicketStore.getState().hydrate({ items: [], note: decision.note });
        closeOccupiedTable(opts.area, opts.label);
      }
    },
    [closeOccupiedTable],
  );

  const syncOpenTableBill = useCallback(
    async (
      area: string,
      label: string,
      gen: number,
      opts: { mayCloseTable: boolean; cancelled?: () => boolean },
    ) => {
      const read = await readTicketForTable(area, label);
      if (opts.cancelled?.() || gen !== hydrateGenRef.current) return;
      let hasCovers = hasLocalCovers(coversKnownRef.current);
      if (
        read.ok &&
        !read.items.some((it) => it && it.voided !== true) &&
        !hasCovers &&
        opts.mayCloseTable
      ) {
        hasCovers = await sessionHasCovers(area, label, coversKnownRef.current);
        if (opts.cancelled?.() || gen !== hydrateGenRef.current) return;
      }
      applyHostBill(read, {
        mayCloseTable: opts.mayCloseTable,
        hasCovers,
        area,
        label,
      });
    },
    [applyHostBill],
  );

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

  // One host read for the selected open table. Optimistic paint from the
  // floor cache, then confirm — never treat "no cache" as an empty bill.
  useEffect(() => {
    if (ticketSyncing) return;
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
      // for an occupied table. Confirm with the host in the background —
      // awaiting that GET on a native shell (10s × 2) left the menu on screen
      // while the WebView was busy, which on a phone felt like a dead UI.
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
        setTicketLoaded(true);
        void window.api.tables
          .listOpen()
          .then((open) => {
            if (cancelled || gen !== hydrateGenRef.current) return;
            const hostSaysOpen =
              Array.isArray(open) &&
              open.some(
                (row: { area?: string; label?: string }) =>
                  row?.area === table.area && row?.label === table.label,
              );
            if (!hostSaysOpen) {
              invalidateTicketCache(table.area, table.label);
              useTicketStore.getState().bindTable(key, { keepLiveBill: false });
              return;
            }
            adoptedHostOpenRef.current = key;
            setOpen(table.area, table.label, true);
          })
          .catch(() => undefined);
        return;
      }
      const peeked = peekTableBill(selectedTable.area, selectedTable.label);
      if (peeked) {
        useTicketStore.getState().hydrate({
          items: peeked.items as any,
          note: peeked.note,
        });
        setTicketLoaded(true);
      } else {
        setTicketLoaded(false);
      }
      try {
        await syncOpenTableBill(selectedTable.area, selectedTable.label, gen, {
          mayCloseTable: true,
          cancelled: () => cancelled,
        });
      } catch {
        // next visibility / ticketsChanged pass retries
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
    syncOpenTableBill,
    setOpen,
    ticketSyncing,
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
    const cats = withSoldByKgFlags(Array.isArray(data) ? data : []);
    setCategories(cats);
    if (cats.length && !selectedCatId) setSelectedCatId(cats[0].id);
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
      if (menuItemSoldByKg(item)) {
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

  const toggleFavSku = useCallback(
    (sku: string) => {
      if (user?.id) fav.toggle(user.id, sku);
    },
    [fav, user?.id],
  );

  const menuTileLabels = useMemo(
    () => ({
      inactive: t('order.itemUnavailableInactive'),
      out: t('order.outOfStockTitle'),
      unavailable: t('order.unavailableAria'),
      lowTitle: t('order.lowStockTitle'),
      lowAria: t('order.lowStockAria'),
      remaining: (count: number) => t('order.stockRemainingBadge', { count }),
      favAdd: t('order.favouriteAddTitle'),
      favRemove: t('order.favouriteRemoveTitle'),
    }),
    [t],
  );

  // Phones keep a SWR menu blob; a background refresh never updates React
  // state unless we load again. Re-pull when the order screen is shown so
  // sold-by-kg flags match the host (Electron skips SWR via the frozen bridge).
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void loadMenu().catch(() => undefined);
    };
    refresh();
    const onVisible = () => {
      if (cancelled) return;
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Store tills only: a USB scanner types the barcode then Enter.
  useEffect(() => {
    if (hasTables) return;
    let cancelled = false;
    let onKeyDown: ((e: KeyboardEvent) => void) | undefined;
    void import('@shared/barcodeScan').then(
      ({ createHidBarcodeBuffer, findItemByProductCode }) => {
        if (cancelled) return;
        const buffer = createHidBarcodeBuffer();
        onKeyDown = (e: KeyboardEvent) => {
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
        if (cancelled) {
          window.removeEventListener('keydown', onKeyDown, true);
        }
      },
    );
    return () => {
      cancelled = true;
      if (onKeyDown) window.removeEventListener('keydown', onKeyDown, true);
    };
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
        if (isSseHealthy()) return;
      }
      const cached = ownerIdFromFloorCache(a, l);
      if (cached) {
        setOwnerId(cached);
        if (isSseHealthy()) return;
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
      void syncOpenTableBill(
        selectedTable.area,
        selectedTable.label,
        hydrateGenRef.current,
        { mayCloseTable: false },
      );
    };

    const onTablesChanged = (ev: Event) => {
      const detail = (ev as CustomEvent).detail || {};
      const area = String(detail.area || '');
      const label = String(detail.label || detail.tableLabel || '');
      if (!selectedTable) return;
      if (area !== selectedTable.area || label !== selectedTable.label) {
        return;
      }
      invalidateTicketCache(selectedTable.area, selectedTable.label);
      if (detail.open === false) {
        adoptedHostOpenRef.current = null;
        useTicketStore
          .getState()
          .bindTable(tableKey(selectedTable.area, selectedTable.label), {
            keepLiveBill: false,
          });
      }
      void syncOpenTableBill(
        selectedTable.area,
        selectedTable.label,
        hydrateGenRef.current,
        { mayCloseTable: detail.open === false },
      );
    };

    const onCatchup = () => {
      void window.api.tables
        .listOpen()
        .then((open) => {
          if (Array.isArray(open)) applyHostOpenTables(open);
        })
        .catch(() => undefined);
      if (!selectedTable) return;
      void syncOpenTableBill(
        selectedTable.area,
        selectedTable.label,
        hydrateGenRef.current,
        { mayCloseTable: false },
      );
    };

    window.addEventListener('pos:ticketsChanged', onTicketsChanged);
    window.addEventListener('pos:tablesChanged', onTablesChanged);
    window.addEventListener('pos:syncCatchup', onCatchup);
    return () => {
      window.removeEventListener('pos:ticketsChanged', onTicketsChanged);
      window.removeEventListener('pos:tablesChanged', onTablesChanged);
      window.removeEventListener('pos:syncCatchup', onCatchup);
    };
  }, [
    selectedTable?.area,
    selectedTable?.label,
    refreshTableOwner,
    syncOpenTableBill,
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
      if (!documentHidden()) void refreshTableOwner(area, label);
      timer = setTimeout(tick, backgroundPollMs());
    };
    timer = setTimeout(tick, backgroundPollMs());
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

  // If an open table's ticket becomes empty due to voids, free the table after
  // the same host read every other screen uses — never close on a missed bill.
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
      const area = selectedTable.area;
      const label = selectedTable.label;
      void syncOpenTableBill(area, label, gen, { mayCloseTable: true });
    }
  }, [
    activeLines.length,
    lines.length,
    selectedTable,
    ticketSyncing,
    ticketPersistReady,
    syncOpenTableBill,
    isOpen(selectedTable?.area || '', selectedTable?.label || ''),
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
        // A backgrounded WebView cannot show the waiter anything, and this
        // loop was the one poll that kept firing anyway — two requests every
        // four seconds (poll plus acknowledgement) from a phone in a pocket.
        if (documentHidden()) return;
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
          await window.api.requests
            .markApplied(outstanding)
            .catch((e: unknown) => {
              reportAppError(e, {
                fallback: t('order.requestFailed'),
                key: 'requests.markApplied',
              });
            });
        }
      } finally {
        // Approved requests have no SSE event, so this poll is their only
        // delivery path — it stays at the base rate while the waiter is
        // looking, and only backs off when the screen is hidden.
        if (alive)
          timer = setTimeout(tick, pollIntervalMs(4000, documentHidden()));
      }
    };
    tick();
    // Skipping while hidden means a resumed screen would otherwise wait out
    // the backed-off timer before picking up a colleague's approved request.
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      // Clear first: `tick` always schedules the next run, so waking without
      // this would leave two chains polling in parallel.
      if (timer) clearTimeout(timer);
      timer = null;
      void tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
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
      // What this cart already had on the bill before this tap. The lines
      // being fired now are deliberately excluded: 1x Water added on top of
      // 3x Water is a second line, not the host's line, and letting it stand
      // in for it would rewrite the bill down to a single water.
      const alreadyOnBill = state.lines
        .filter((l) => l.staged !== true)
        .map((l) => toTicketLogLine(l, { fired: true }));
      const logItems = restoreMissingServerLines(
        state.lines.map((l) =>
          toTicketLogLine(l, {
            fired:
              l.voided === true || l.staged !== true || firingIds.has(l.id),
          }),
        ),
        onServer,
        alreadyOnBill,
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
        // Do not await: the host already accepted the order, and TCP to
        // kitchen/bar printers used to freeze this button for 5–90s.
        void printTicket({
          area: selectedTable.area,
          tableLabel: selectedTable.label,
          covers: opts.covers,
          items: printLines,
          note: state.orderNote,
          userName: user.displayName,
          meta: printMeta,
        })
          .then((printed) => {
            if (printed?.queued) {
              toast.warn(
                isFireOrder
                  ? t('order.kitchenPrintQueued')
                  : t('order.ticketPrintQueued'),
              );
            }
          })
          .catch((e: unknown) => {
            if (typeof console !== 'undefined')
              console.warn('[print/ticket] failed:', e);
            toast.warn(
              isFireOrder
                ? t('order.kitchenPrintQueued')
                : t('order.ticketPrintQueued'),
            );
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

  const toggleLineSelect = useCallback((id: string) => {
    setSelectedLineId((prev) => (prev === id ? null : id));
  }, []);

  const openVoidTarget = useCallback((line: TicketLine) => {
    setVoidTarget({
      id: line.id,
      name: line.name,
      qty: line.qty,
      unitPrice: line.unitPrice,
      vatRate: line.vatRate,
      note: line.note,
    });
  }, []);

  const renderTicketLine = useCallback(
    (line: TicketLine) => (
      <TicketLineRow
        line={line}
        formatAmount={formatAmount}
        isTableOpen={isTableOpen}
        showRequestOnly={showRequestOnly}
        hasTables={hasTables}
        selected={selectedLineId === line.id}
        onToggleSelect={toggleLineSelect}
        onIncrement={increment}
        onDecrement={decrement}
        onRemove={removeLine}
        onVoid={openVoidTarget}
        onNoteChange={setLineNote}
      />
    ),
    [
      decrement,
      formatAmount,
      hasTables,
      increment,
      isTableOpen,
      openVoidTarget,
      removeLine,
      selectedLineId,
      setLineNote,
      showRequestOnly,
      toggleLineSelect,
    ],
  );

  const fireCourseFromBoard = useCallback(
    (courseId: string) => {
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
            typeof coversKnownRef.current === 'number'
              ? coversKnownRef.current
              : await window.api.covers.getLast(
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
            (e as { message?: string })?.message || e || '',
          ).trim();
          toast.error(raw || t('order.toastTryAgain'), {
            title: t('order.toastSendFailed'),
          });
        } finally {
          setBusyAction(null);
        }
      })();
    },
    [busyAction, connectionOk, runKitchenFire, selectedTable, t, ticketSyncing],
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
      ? peekTableBill(selectedTable.area, selectedTable.label)
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
  const catClass = columnMenu ? 'pos-menu-cat--rail' : 'pos-menu-cat--grid';
  const catTileCount = 1 + (hasTables ? 1 : 0) + categories.length;
  const catPad = columnMenu
    ? 0
    : catGridPadCount(catTileCount, catGridWide ? 3 : 2);
  const showingComments =
    !query.trim() && hasTables && selectedCatId === COMMENTS_CAT_ID;
  const itemTileCount = showingComments
    ? commentPresets.length + customCommentButtons.length + 1
    : filteredItems.length;
  const itemCols = columnMenu
    ? catGridWide
      ? 3
      : itemGridMid
        ? 2
        : 1
    : catGridWide
      ? 3
      : 2;
  const itemPad = catGridPadCount(itemTileCount, itemCols);
  // Phone layout is a stack, not two columns. Keep only the visible pane
  // mounted: the ticket tree used to stay in the DOM with `flex` + `hidden`,
  // and on Tailwind v4 those two `display` utilities can fight so a
  // transparent ticket pane sits on top of the menu and eats every tap.
  const showMenuPane = twoPane || mobilePane === 'menu';
  const showTicketPane = twoPane || mobilePane === 'ticket';

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
      <div className="md:hidden pos-surface-panel flex items-center gap-1.5 rounded-[0.85rem] p-1.5">
        {hasTables ? (
          <button
            className="pos-ticket-iconbtn"
            onClick={() => navigate('/app/tables')}
            type="button"
            aria-label={t('order.backToTables')}
            title={t('order.backToTables')}
          >
            <IconChevronLeft />
          </button>
        ) : null}
        <div className="pos-segmented flex-1 !rounded-[0.7rem] p-1">
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

      {showMenuPane ? (
        <div
          className={`md:col-span-2 min-h-0 min-w-0 h-full flex flex-1 flex-col ${
            lockOrderScroll || columnMenu ? 'overflow-hidden' : 'overflow-auto'
          }`}
        >
          <div className="relative mb-3 w-full shrink-0">
            <span className="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-[color:var(--pos-fg-muted)]">
              <IconSearch />
            </span>
            <input
              placeholder={t(
                hasTables ? 'order.searchMenu' : 'order.searchProductsScan',
              )}
              className="pos-input pos-menu-search w-full"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="pos-menu-search-layout"
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
              className={columnMenu ? 'pos-menu-rail' : 'pos-menu-cats-grid'}
            >
              {/* Favourites tab */}
              <button
                key={FAVOURITES_CAT_ID}
                onClick={() => setSelectedCatId(FAVOURITES_CAT_ID)}
                className={`pos-menu-cat ${catClass} ${
                  selected?.id === FAVOURITES_CAT_ID
                    ? 'pos-menu-cat--active'
                    : ''
                }`}
              >
                <span className="pos-menu-cat-label">
                  <span className="pos-menu-cat-mark">
                    <IconHeart className="size-3.5 text-pink-400" />
                  </span>
                  <span className="min-w-0 line-clamp-2">
                    {t('order.favourites')}
                  </span>
                </span>
              </button>
              {hasTables ? (
                <button
                  key={COMMENTS_CAT_ID}
                  onClick={() => setSelectedCatId(COMMENTS_CAT_ID)}
                  className={`relative pos-menu-cat ${catClass} ${
                    selected?.id === COMMENTS_CAT_ID
                      ? 'pos-menu-cat--active'
                      : ''
                  }`}
                >
                  <span className="pos-menu-cat-label">
                    <CategorySwatch color={COMMENT_TILE_BG} />
                    <span className="min-w-0 line-clamp-2">
                      {t('order.comments')}
                    </span>
                  </span>
                </button>
              ) : null}
              {categories.map((c) => {
                const tabColor = c.color || null;
                const isActive = selected?.id === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCatId(c.id)}
                    className={`relative pos-menu-cat ${catClass} ${
                      isActive ? 'pos-menu-cat--active' : ''
                    }`}
                  >
                    <span className="pos-menu-cat-label">
                      <CategorySwatch color={tabColor || FALLBACK_TILE_BG} />
                      <span className="min-w-0 line-clamp-2">{c.name}</span>
                    </span>
                  </button>
                );
              })}
              {Array.from({ length: catPad }, (_, i) => (
                <div
                  key={`cat-pad-${i}`}
                  className="pos-menu-cat pos-menu-cat--grid pos-menu-cat--pad"
                  aria-hidden
                />
              ))}
            </div>
            <div
              className={
                columnMenu
                  ? 'grid min-h-0 min-w-0 flex-1 grid-cols-1 content-start gap-2 overflow-x-hidden overflow-y-auto overscroll-x-none overscroll-y-contain touch-pan-y auto-rows-[6.25rem] min-[380px]:grid-cols-2 sm:grid-cols-3'
                  : 'grid grid-cols-2 content-start gap-2 auto-rows-[6.25rem] sm:grid-cols-3'
              }
            >
              {!query.trim() &&
              hasTables &&
              selectedCatId === COMMENTS_CAT_ID ? (
                <>
                  {[...commentPresets, ...customCommentButtons].map(
                    (phrase) => (
                      <button
                        key={phrase}
                        type="button"
                        className="pos-menu-tile cursor-pointer"
                        style={menuTileStyle(COMMENT_TILE_BG, uiTheme)}
                        disabled={ticketSyncing || busyAction != null}
                        onClick={() => appendOrderComment(phrase)}
                      >
                        <div className="font-medium leading-snug">{phrase}</div>
                      </button>
                    ),
                  )}
                  <button
                    type="button"
                    className="pos-menu-tile cursor-pointer font-medium leading-snug"
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
              ).map((i: MenuItemDTO) => (
                <MenuItemTile
                  key={i.id}
                  item={i}
                  isFav={fav.isFav(user?.id || null, i.sku)}
                  locked={ticketSyncing || busyAction != null}
                  uiTheme={uiTheme}
                  categoryColor={categoryColorById.get(Number(i.categoryId))}
                  qty={qtyBySku.get(i.sku) || 0}
                  showQtyBubble={!twoPane}
                  labels={menuTileLabels}
                  onAdd={addMenuItemToSale}
                  onToggleFav={toggleFavSku}
                />
              ))}
              {Array.from({ length: itemPad }, (_, i) => (
                <div
                  key={`item-pad-${i}`}
                  className="pos-menu-tile pos-menu-tile--pad"
                  aria-hidden
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showTicketPane ? (
        <div className="pos-ticket-pane flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="mb-2 shrink-0 space-y-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold leading-tight">
                  {selectedTable
                    ? t(hasTables ? 'order.ticketHeader' : 'order.saleHeader', {
                        label: selectedTable.label,
                      })
                    : t(hasTables ? 'order.ticket' : 'order.cart')}
                </div>
                {hasTables &&
                selectedTable &&
                isOpen(selectedTable.area, selectedTable.label) &&
                openedAtMs ? (
                  <OpenTableElapsed openedAtMs={openedAtMs} />
                ) : null}
              </div>
            </div>
            {hasTables ? (
              <div className="flex items-center gap-2">
                <div
                  role="tablist"
                  aria-label={t('order.addModeLabel')}
                  aria-disabled={isTableOpen}
                  className={`inline-flex min-h-11 flex-1 items-stretch overflow-hidden rounded-lg border border-[var(--pos-border-strong)] ${
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
                      <span key={mode} className="flex min-w-0 flex-1">
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
                          onPointerDown={() => {
                            if (mode === 'course' || mode === 'seat') {
                              void loadTicketCourseBoard();
                            }
                          }}
                          onPointerEnter={() => {
                            if (mode === 'course' || mode === 'seat') {
                              void loadTicketCourseBoard();
                            }
                          }}
                          onClick={() => setAddMode(mode)}
                          className={`flex min-h-11 min-w-0 flex-1 items-center justify-center disabled:pointer-events-none disabled:cursor-not-allowed ${
                            active
                              ? 'bg-[var(--pos-accent-soft)] text-[var(--pos-accent)]'
                              : 'text-[color:var(--pos-fg-muted)]'
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
                {hasTables &&
                selectedTable &&
                isOpen(selectedTable.area, selectedTable.label) ? (
                  <button
                    type="button"
                    className="pos-ticket-iconbtn pos-ticket-pairbtn"
                    onClick={() => {
                      if (!canEditCovers) return;
                      setCoversMode('editOnly');
                      setCoversValue(
                        typeof coversKnown === 'number'
                          ? String(coversKnown)
                          : '1',
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
                    <IconCovers className="size-3.5 shrink-0" />
                    <span className="tabular-nums text-[13px] font-semibold leading-none">
                      {typeof coversKnown === 'number' ? coversKnown : '—'}
                    </span>
                  </button>
                ) : null}
                {canTransfer ? (
                  <button
                    type="button"
                    className="pos-ticket-iconbtn pos-ticket-pairbtn"
                    onClick={() => setShowTransfer(true)}
                    title={t('order.transferTitle')}
                    aria-label={t('order.transfer')}
                  >
                    <IconMoveRight className="size-4" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div
            className={`flex-1 min-h-0 relative ${lockOrderScroll ? 'overflow-hidden' : 'overflow-auto'}`}
          >
            <div className="flex min-h-full flex-col space-y-2">
              {billUnknown ? (
                <div role="alert" className="pos-alert p-3">
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
              {(addMode === 'course' || addMode === 'seat') && hasTables ? (
                <Suspense fallback={null}>
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
                        ? printSeatBill
                        : undefined
                    }
                    onFireCourse={isTableOpen ? fireCourseFromBoard : undefined}
                    renderLine={renderTicketLine}
                  />
                </Suspense>
              ) : lines.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-3 text-center text-sm opacity-60">
                  {t('order.selectItems')}
                </div>
              ) : (
                lines.map((line) => (
                  <TicketLineRow
                    key={line.id}
                    line={line}
                    formatAmount={formatAmount}
                    isTableOpen={isTableOpen}
                    showRequestOnly={showRequestOnly}
                    hasTables={hasTables}
                    selected={selectedLineId === line.id}
                    onToggleSelect={toggleLineSelect}
                    onIncrement={increment}
                    onDecrement={decrement}
                    onRemove={removeLine}
                    onVoid={openVoidTarget}
                    onNoteChange={setLineNote}
                  />
                ))
              )}
            </div>
          </div>

          {/* Footer pinned at the bottom of the ticket panel as a flex child.
            Was previously `absolute bottom-0` with `pb-80` on the items list,
            which overlapped the last item on narrow viewports. */}
          <div className="mt-2 shrink-0 border-t border-[var(--pos-hairline)] pt-3 md:-mx-3 md:-mb-3 md:rounded-b md:bg-[var(--pos-surface)] md:p-3">
            <div className="space-y-3 text-sm">
              {hasTables &&
              (showOrderNote || Boolean(String(orderNote || '').trim())) ? (
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
                    const disabled = ticketOpen || requestOnly;
                    const hasNote = Boolean(String(orderNote || '').trim());
                    return (
                      <textarea
                        className={`w-full pos-input px-2 py-2 ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                        rows={2}
                        placeholder={t('order.orderNotesPlaceholder')}
                        value={orderNote}
                        disabled={disabled}
                        autoFocus={showOrderNote && !hasNote && !disabled}
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

              <div className="flex flex-col gap-2">
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
                        className="pos-ticket-pay"
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
                  const clearBtnLabel =
                    busyAction === 'void'
                      ? t('order.voidingBtn')
                      : selectedTable &&
                          isOpen(selectedTable.area, selectedTable.label)
                        ? t('order.voidTicket')
                        : t('order.clear');
                  return (
                    <>
                      <div className="flex gap-2">
                        <button
                          className="pos-ticket-iconbtn pos-ticket-iconbtn--danger"
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
                              : clearBtnLabel
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
                                        approvedByAdminId:
                                          approvedByAdmin.userId,
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
                                ).catch((e: unknown) => {
                                  reportAppError(e, {
                                    fallback: t('order.toastTryAgain'),
                                    key: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                                  });
                                });
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
                          aria-label={clearBtnLabel}
                        >
                          <IconTrash className="size-4" />
                        </button>
                        {hasTables ? (
                          <button
                            type="button"
                            className="pos-ticket-iconbtn"
                            title={t('order.addOrderNote')}
                            aria-label={t('order.addOrderNote')}
                            aria-pressed={showOrderNote}
                            disabled={
                              (Boolean(isTableOpen) || showRequestOnly) &&
                              !String(orderNote || '').trim()
                            }
                            onClick={() => setShowOrderNote((v) => !v)}
                          >
                            <IconEdit className="size-4" />
                          </button>
                        ) : null}
                        {hasTables ? (
                          <button
                            className="pos-ticket-tool"
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
                                setCoversValue('1');
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
                                const lastCovers =
                                  typeof coversKnown === 'number'
                                    ? coversKnown
                                    : await window.api.covers.getLast(
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
                                // Not awaited: this runs while `busyAction` holds
                                // the full-screen lock, and the chit has already
                                // fired. Blocking the lock on a table flag is what
                                // made a slow host look like a frozen app.
                                void tryOrQueue(
                                  'tables.setOpen',
                                  {
                                    area: selectedTable.area,
                                    label: selectedTable.label,
                                    open: true,
                                  },
                                  {
                                    dedupeKey: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                                  },
                                ).catch((e: unknown) => {
                                  reportAppError(e, {
                                    fallback: t('order.toastTryAgain'),
                                    key: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                                  });
                                });
                              } catch (e: any) {
                                const raw = String(
                                  e?.message || e || '',
                                ).trim();
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
                                toast.error(
                                  detail || t('order.toastTryAgain'),
                                  {
                                    title,
                                  },
                                );
                                if (typeof console !== 'undefined')
                                  console.warn('[print/ticket] failed:', e);
                              } finally {
                                setBusyAction(null);
                              }
                            }}
                            type="button"
                          >
                            <IconPrinter className="size-4" />
                            {busyAction === 'send'
                              ? t('order.sendingOrder')
                              : lines.some((l) => l.staged)
                                ? t('order.sendOrder')
                                : t('order.printTicket')}
                          </button>
                        ) : null}
                      </div>
                      <button
                        className="pos-ticket-pay"
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
      ) : null}

      {showPayment && selectedTable && (
        <PaymentCheckout
          open
          busy={busyAction === 'pay'}
          busyMessage={
            vatEnabled
              ? t('order.registeringFiscal')
              : t('order.processingPaymentOverlay')
          }
          busyDetail={
            vatEnabled
              ? t('order.recordingPaymentFiscal')
              : t('order.recordingPayment')
          }
          hasTables={hasTables}
          tableLabel={selectedTable.label}
          saleLabel={t('order.saleHeader', { label: selectedTable.label })}
          coversKnown={coversKnown}
          addMode={addMode}
          payingSeatName={payingSeatName}
          seatPayRows={seatPayRows}
          paySeatId={paySeatId}
          remainingSeats={unpaidSeatIds(seats, lines).length}
          payLines={payLines}
          totals={totals}
          serviceChargeCfg={serviceChargeCfg}
          serviceChargeAmount={serviceChargeAmount}
          applyServiceCharge={applyServiceCharge}
          discountAmount={discountAmount}
          discountType={discountType}
          discountValue={discountValue}
          discountReason={discountReason}
          totalDue={totalDue}
          eurDue={eurDue}
          eurExchangeRate={eurExchangeRate}
          splitGuestCount={splitGuestCount}
          split={split}
          eurPerPerson={eurPerPerson}
          paymentMethod={paymentMethod}
          cashSuggestions={cashSuggestions}
          cashTendered={cashTendered}
          cashTenderedNum={cashTenderedNum}
          cashChange={cashChange}
          formatAmount={formatAmount}
          posCurrency={posCurrency}
          printReceipt={printReceipt}
          managerPinHint={
            (approvalsCfg.requireManagerPinForDiscount && discountAmount > 0) ||
            (approvalsCfg.requireManagerPinForServiceChargeRemoval &&
              serviceChargeCfg.enabled &&
              serviceChargeConfiguredAmount > 0 &&
              !applyServiceCharge)
          }
          confirmDisabled={
            busyAction != null || !connectionOk || payLines.length === 0
          }
          confirmLabel={
            addMode === 'seat' && payingSeatName
              ? t('order.paySeatWithTotal', {
                  label: payingSeatName,
                  amount: formatAmount(totalDue),
                })
              : t('order.payWithTotal', {
                  amount: formatAmount(totalDue),
                })
          }
          confirmEur={eurDue}
          onClose={() => setShowPayment(false)}
          onPaySeat={(id) => {
            setPaySeatId(id);
            setCashTendered('');
            setDiscountType('NONE');
            setDiscountValue('');
          }}
          onApplyServiceCharge={setApplyServiceCharge}
          onDiscountType={setDiscountType}
          onDiscountValue={setDiscountValue}
          onDiscountReason={setDiscountReason}
          onSplitGuestCount={setSplitGuestCount}
          onPaymentMethod={(next) => setPaymentMethod(next)}
          onCashTendered={setCashTendered}
          onTogglePrint={() => setPrintReceipt((v) => !v)}
          onConfirm={async () => {
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
                approvalsCfg.requireManagerPinForDiscount && discountAmount > 0;
              const needsServiceRemovalApproval =
                approvalsCfg.requireManagerPinForServiceChargeRemoval &&
                serviceChargeCfg.enabled &&
                serviceChargeConfiguredAmount > 0 &&
                !applyServiceCharge;
              let managerApprovedBy: {
                userId: number;
                userName: string;
              } | null = null;
              if (needsDiscountApproval || needsServiceRemovalApproval) {
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
                const payResult = await tryOrQueue('payments.record', {
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
                        : Number(String(discountValue || '').replace(',', '.')),
                    discountAmount,
                    discountReason: (discountReason || '').trim() || null,
                    totalAfter: totalDue,
                    managerApprovedById: managerApprovedBy?.userId ?? null,
                    managerApprovedByName: managerApprovedBy?.userName ?? null,
                    closeTable,
                    seatLabel: payingSeatLabel,
                    seatId: paySeatId || undefined,
                  },
                });
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
                  if ((payResult.result as any)?.fiscalPending) {
                    toast.warn(t('order.paymentRecordedFiscalQueued'));
                  } else if (printed === false) {
                    toast.warn(t('order.paymentRecordedPrintQueued'));
                  }
                }
              } catch (e: any) {
                if (String(e?.code || '') === 'TABLE_ALREADY_PAID') {
                  toast.info(t('order.alreadyPaid'));
                  paymentAccepted = true;
                } else {
                  const detail = String(e?.message || '').trim();
                  toast.error(detail || t('order.paymentNotRecorded'), {
                    title: t('order.paymentBlocked'),
                  });
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
                      typeof coversKnown === 'number' ? coversKnown : null,
                    items: snapshot,
                    note: orderNote || undefined,
                    stockConsumeLines: [],
                    kdsFireItems: [],
                  }).catch((e: unknown) => {
                    reportAppError(e, {
                      fallback: t('order.toastTryAgain'),
                      key: `tickets.log:${selectedTable.area}:${selectedTable.label}`,
                    });
                  });
                }
                if (closeTableAfterPay) {
                  setOpen(selectedTable.area, selectedTable.label, false);
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
        />
      )}

      {showTransfer && selectedTable && user?.id && (
        <div
          className="pos-overlay"
          onClick={() => {
            if (transferBusy) return;
            setShowTransfer(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="pos-dialog w-full max-w-lg p-5 sm:rounded-[0.85rem]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="pos-dialog-title">{t('order.transferTable')}</div>
              <button
                type="button"
                className="pos-ticket-iconbtn"
                onClick={() => setShowTransfer(false)}
                aria-label={t('common.close')}
              >
                <IconClose />
              </button>
            </div>

            <div className="mb-3 text-sm text-[color:var(--pos-fg-muted)]">
              {t('order.from')}:{' '}
              <b className="text-[color:var(--pos-fg)]">
                {selectedTable.area} {selectedTable.label}
              </b>
            </div>

            <div className="pos-segmented mb-4 w-full">
              <button
                className={`pos-segment flex-1 ${
                  transferMode === 'WAITER' ? 'pos-segment--active' : ''
                }`}
                onClick={() => {
                  setTransferMode('WAITER');
                  setTransferError(null);
                }}
                type="button"
              >
                {t('order.toWaiter')}
              </button>
              <button
                className={`pos-segment flex-1 ${
                  transferMode === 'TABLE' ? 'pos-segment--active' : ''
                }`}
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
                    <div className="text-sm text-[color:var(--pos-fg-muted)]">
                      {t('order.selectWaiter')}
                    </div>
                    <select
                      className="pos-input disabled:opacity-60"
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
                <div className="text-sm text-[color:var(--pos-fg-muted)]">
                  {t('order.destination')}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select
                    className="pos-input disabled:opacity-60"
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
                    className="pos-input disabled:opacity-60"
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
              <div className="pos-alert mt-3">{transferError}</div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="pos-ticket-tool"
                onClick={() => setShowTransfer(false)}
                disabled={transferBusy}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="pos-ticket-pay !w-auto flex-1"
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
        <div
          className="pos-overlay"
          onClick={() => {
            if (busyAction != null) return;
            setShowCovers(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pos-covers-title"
            className="pos-dialog w-full max-w-sm p-5 sm:rounded-[0.85rem]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id="pos-covers-title"
              className="pos-dialog-title mb-4 text-center"
            >
              {coversMode === 'editOnly'
                ? `${t('order.coversEditTitle')} ${selectedTable.label}`
                : `${t('order.coversOpenTitle')} ${selectedTable.label}`}
            </h3>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                className="pos-pay-stepper inline-flex items-center justify-center"
                disabled={Math.floor(Number(coversValue) || 0) <= 1}
                onClick={() =>
                  setCoversValue(
                    String(
                      Math.max(1, Math.floor(Number(coversValue) || 1) - 1),
                    ),
                  )
                }
                aria-label="−"
              >
                −
              </button>
              <div
                className="flex h-[2.75rem] w-[4.5rem] items-center justify-center rounded-[0.7rem] border border-[var(--pos-border-strong)] bg-[var(--pos-surface)] text-lg font-semibold tabular-nums"
                aria-live="polite"
                aria-label={t('order.editCovers')}
              >
                {Math.max(1, Math.floor(Number(coversValue) || 1))}
              </div>
              <button
                type="button"
                className="pos-pay-stepper inline-flex items-center justify-center"
                disabled={Math.floor(Number(coversValue) || 0) >= 99}
                onClick={() =>
                  setCoversValue(
                    String(
                      Math.min(
                        99,
                        Math.max(1, Math.floor(Number(coversValue) || 0) + 1),
                      ),
                    ),
                  )
                }
                aria-label="+"
              >
                +
              </button>
            </div>
            {coversMode === 'openAndSend' ? (
              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[13px]">
                  <IconPrinter />
                  <span>{t('order.printStationTickets')}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={printStationTickets}
                  className={`pos-pay-switch ${
                    printStationTickets ? 'pos-pay-switch--on' : ''
                  }`}
                  onClick={() => setPrintStationTickets((v) => !v)}
                  aria-label={t('order.togglePrintStationTickets')}
                >
                  <span aria-hidden className="pos-pay-switch-knob" />
                </button>
              </div>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="pos-ticket-tool"
                onClick={() => setShowCovers(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="pos-ticket-pay !w-auto flex-1"
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
                    ).catch((e: unknown) => {
                      reportAppError(e, {
                        fallback: t('order.toastTryAgain'),
                        key: `covers.save:${selectedTable.area}:${selectedTable.label}`,
                      });
                    });
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
                    setOpen(selectedTable.area, selectedTable.label, true);
                    // IMPORTANT: when opening a table in cloud mode,
                    // set "open" first so the cloud "openAt" timestamp
                    // exists BEFORE we write covers/tickets (tooltip
                    // uses openAt as the session start).
                    // PR 4a: route through the queue so an offline
                    // open-and-send still records the table-open and
                    // covers (the ticket itself is already covered by
                    // logTicket → 'tickets.log'). Live attempts are
                    // budgeted so a slow host cannot hold this lock
                    // for the native 15s×2 window.
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
                    ).catch((e: unknown) => {
                      reportAppError(e, {
                        fallback: t('order.toastTryAgain'),
                        key: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                      });
                    });
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
                    ).catch((e: unknown) => {
                      reportAppError(e, {
                        fallback: t('order.toastTryAgain'),
                        key: `covers.save:${selectedTable.area}:${selectedTable.label}`,
                      });
                    });
                    setCoversKnown(num);
                    setShowCovers(false);
                    if (!user?.id) return;
                    const fired = await runKitchenFire({
                      covers: num,
                      firstSend: true,
                      printKitchen: printStationTickets,
                    });
                    if (!fired.ok) return;
                    // Best-effort "ensure open" after printing. Shares the
                    // dedupe key above so landing here retires the queued
                    // copy instead of letting it replay once the table is
                    // paid and freed. Not awaited: the chit has already
                    // fired, so holding the send lock open for a repeat of a
                    // write we made moments ago buys the waiter nothing.
                    void tryOrQueue(
                      'tables.setOpen',
                      {
                        area: selectedTable.area,
                        label: selectedTable.label,
                        open: true,
                      },
                      {
                        dedupeKey: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                      },
                    ).catch((e: unknown) => {
                      reportAppError(e, {
                        fallback: t('order.toastTryAgain'),
                        key: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                      });
                    });
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
        <div
          className="pos-overlay"
          onClick={() => {
            if (ticketSyncing) return;
            setVoidTarget(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="pos-dialog w-full max-w-sm p-5 sm:rounded-[0.85rem]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="pos-dialog-title mb-2 text-center">
              {t('order.voidItemTitle')}
            </h3>
            <p className="mb-4 text-center text-sm text-[color:var(--pos-fg-muted)]">
              {t('order.voidItemBody', {
                name: voidTarget.name,
                qty: voidTarget.qty,
                area: selectedTable.area,
                label: selectedTable.label,
              })}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="pos-ticket-tool"
                onClick={() => setVoidTarget(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="pos-ticket-pay pos-ticket-pay--danger !w-auto flex-1"
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
                  hydrateGenRef.current += 1;
                  const vt = voidTarget;
                  if (!vt) return;
                  setVoidTarget(null);
                  markLineVoided(vt.id);
                  const remaining = useTicketStore
                    .getState()
                    .lines.filter((l) => !l.voided && !l.paid);
                  void tryOrQueue('tickets.voidItem', {
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
                  })
                    .then(() => {
                      void raceWithBudget(
                        window.api.tickets.getLatestForTable(
                          selectedTable.area,
                          selectedTable.label,
                        ),
                        LIVE_TICKET_BUDGET_MS,
                      ).then((latest) => {
                        if (!latest) return;
                        const allItems = ((latest as any)?.items ||
                          []) as any[];
                        useTicketStore.getState().hydrate({
                          items: allItems as any,
                          note: (latest as any)?.note || '',
                        });
                      });
                    })
                    .catch(() => {
                      toast.error(t('order.voidItemFailed'));
                    });
                  if (remaining.length === 0) {
                    setOpen(selectedTable.area, selectedTable.label, false);
                    void tryOrQueue(
                      'tables.setOpen',
                      {
                        area: selectedTable.area,
                        label: selectedTable.label,
                        open: false,
                      },
                      {
                        dedupeKey: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                      },
                    ).catch((e: unknown) => {
                      reportAppError(e, {
                        fallback: t('order.toastTryAgain'),
                        key: `tables.setOpen:${selectedTable.area}:${selectedTable.label}`,
                      });
                    });
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
          className="pos-overlay"
          onClick={() => setCustomCommentOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="pos-dialog w-full max-w-sm p-5 sm:rounded-[0.85rem]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="pos-dialog-title mb-3 text-center">
              {t('order.writeComment')}
            </h3>
            <textarea
              ref={customCommentInputRef}
              className="pos-input mb-3 min-h-[80px] resize-y"
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
                className="pos-ticket-tool"
                onClick={() => setCustomCommentOpen(false)}
              >
                {t('common.close')}
              </button>
              <button
                type="button"
                className="pos-ticket-pay !w-auto flex-1"
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

      <Modal
        open={Boolean(weightModal)}
        onClose={() => {
          setWeightModal(null);
          setWeightInput('');
          setWeightUnit('kg');
        }}
        title={t('order.weightTitle')}
        description={weightModal?.name}
        size="sm"
        footer={
          <>
            <button
              type="button"
              className="pos-ticket-tool"
              onClick={() => {
                setWeightModal(null);
                setWeightInput('');
                setWeightUnit('kg');
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="pos-ticket-pay !w-auto flex-1"
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
          </>
        }
      >
        <div className="mb-3 grid grid-cols-3 gap-2">
          {[...'123456789'].map((d) => (
            <button
              key={d}
              type="button"
              className="pos-keypad-key"
              onClick={() => setWeightInput((v) => v + d)}
            >
              {d}
            </button>
          ))}
          <button
            type="button"
            className="pos-keypad-key"
            onClick={() => setWeightInput((v) => v + '0')}
          >
            0
          </button>
          <button
            type="button"
            className="pos-keypad-key"
            onClick={() =>
              setWeightInput((v) => (v.includes('.') ? v : v + '.'))
            }
          >
            .
          </button>
          <button
            type="button"
            className="pos-keypad-key"
            onClick={() => setWeightInput('')}
          >
            {t('order.clear')}
          </button>
        </div>
        <div className="pos-segmented mb-3 w-full">
          <button
            type="button"
            className={`pos-segment flex-1 ${
              weightUnit === 'kg' ? 'pos-segment--active' : ''
            }`}
            onClick={() => setWeightUnit('kg')}
          >
            kg
          </button>
          <button
            type="button"
            className={`pos-segment flex-1 ${
              weightUnit === 'g' ? 'pos-segment--active' : ''
            }`}
            onClick={() => setWeightUnit('g')}
          >
            g
          </button>
        </div>
        <input
          className="pos-input text-center text-lg font-semibold tabular-nums"
          placeholder={t('order.weightPlaceholder')}
          inputMode="decimal"
          value={weightInput ? `${weightInput} ${weightUnit}` : ''}
          onChange={(e) => {
            const digits = e.target.value
              .replace(/[^0-9.]/g, '')
              .replace(/(\..*)\./g, '$1');
            setWeightInput(digits);
          }}
        />
      </Modal>

      {approvalModal.open && (
        <div className="pos-overlay">
          <div
            role="dialog"
            aria-modal="true"
            className="pos-dialog w-full max-w-sm p-5 sm:rounded-[0.85rem]"
          >
            <div className="pos-dialog-title mb-1">
              {approvalModal.kind === 'ADMIN'
                ? t('order.adminApproval')
                : t('order.managerApproval')}
            </div>
            <div className="mb-3 text-sm text-[color:var(--pos-fg-muted)]">
              {approvalModal.action}
            </div>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              className="pos-input py-3 text-center tracking-[0.45em] tabular-nums"
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
              <div className="pos-alert mt-2">{approvalModal.error}</div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="pos-ticket-tool"
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
                type="button"
                className="pos-ticket-pay !w-auto flex-1"
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

function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) {
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function OpenTableElapsed({ openedAtMs }: { openedAtMs: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="mt-0.5 font-mono text-[12px] tabular-nums text-[color:var(--pos-fg-muted)]">
      {formatElapsed(nowMs - openedAtMs)}
    </div>
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
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-[color:var(--pos-fg-muted)]">
          {t('common.total')}
        </span>
        <span className="text-[1.65rem] font-bold leading-none tabular-nums">
          {formatAmount(totalWithService)}
        </span>
      </div>
      {vatEnabled ? (
        <div className="flex justify-between text-[11px] leading-snug opacity-70">
          <span>{t('common.vat')}</span>
          <span> {formatAmount(totals.vat)}</span>
        </div>
      ) : (
        <div className="flex justify-between text-[11px] leading-snug opacity-70">
          <span>{t('common.vat')}</span>
          <span>{t('common.vatDisabled')}</span>
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
