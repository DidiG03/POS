import { z } from 'zod';

export type UserRole =
  | 'ADMIN'
  | 'CASHIER'
  | 'WAITER'
  | 'KP'
  | 'CHEF'
  | 'HEAD_CHEF'
  | 'FOOD_RUNNER'
  | 'HOST'
  | 'BUSSER'
  | 'BARTENDER'
  | 'BARBACK'
  | 'CLEANER';

export interface UserDTO {
  id: number;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export interface SettingsDTO {
  restaurantName: string;
  businessInfo?: {
    address?: string;
    phone?: string;
    email?: string;
    website?: string;
  };
  currency: string;
  defaultVatRate: number;
  preferences?: {
    /** UI locale for the venue (`sq` = Albanian). Stored for consistency; translations can grow over time. */
    language?: 'en' | 'sq';
    vatEnabled?: boolean;
    serviceCharge?: {
      enabled?: boolean;
      mode?: 'PERCENT' | 'AMOUNT';
      value?: number; // percent or fixed amount (same currency)
    };
  };
  // Multi-printer support (recommended). Backward compatible with legacy `printer`.
  printers?: PrinterProfileDTO[];
  printerRouting?: {
    enabled?: boolean;
    // Which printer prints customer receipts (PAYMENT)
    receiptPrinterId?: string;
    // For ORDER slips: route by station (KITCHEN/BAR/DESSERT) and/or a fallback.
    station?: Partial<Record<'KITCHEN' | 'BAR' | 'DESSERT' | 'ALL', string>>;
    // Optional: route by categoryId (takes precedence over station if present).
    categories?: Record<string, string>;
  };
  printer?: {
    mode?: 'NETWORK' | 'SYSTEM' | 'SERIAL';
    ip?: string;
    port?: number;
    // System/USB printing via OS printer queue (recommended for USB-connected printers)
    deviceName?: string;
    silent?: boolean; // default true
    // macOS/Linux: send raw ESC/POS bytes via CUPS (bypasses PostScript drivers)
    systemRawEscpos?: boolean;
    // Serial ESC/POS printing (RS-232/USB-serial adapters)
    serialPath?: string; // e.g. COM3 (Windows) or /dev/tty.usbserial-XXXX (macOS)
    baudRate?: number; // e.g. 19200
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd';
    usbVendorId?: number;
    usbProductId?: number;
  };
  enableAdmin?: boolean;
  tableCountMainHall?: number;
  tableCountTerrace?: number;
  tableAreas?: TableAreaDTO[];
  security?: {
    allowLan?: boolean;
    requirePairingCode?: boolean;
    pairingCode?: string;
  };
  cloud?: {
    backendUrl?: string; // e.g. https://api.example.com
    businessCode?: string; // tenant code, e.g.  Code Orbit
    // Provider-supplied shared secret used to access certain public cloud endpoints.
    // NOTE: this should remain stored only on the POS host; do not expose to tablets via /settings.
    accessPassword?: string;
  };
  /** Albanian fiskalizimi via certified middleware (e.g. easyPos). */
  fiscal?: {
    enabled?: boolean;
    provider?: 'easypos';
    /** Local: http://127.0.0.1:8080 — Cloud: https://api.dev.easypos.al/fiscalisation-service/v1 */
    baseUrl?: string;
    /** Stored on the POS host only; redacted from settings:get. */
    authToken?: string;
    /** Set by settings:get when a token is saved (renderer never sees the token). */
    authTokenConfigured?: boolean;
    /** Cloud API only — sent as `integration-app` header. */
    integrationApp?: string;
    defaultOperatorId?: string;
    /** Unit of measure sent as soldIn (easyPos catalog must include it). */
    defaultSoldIn?: string;
    /** Cloud demo: force articleId from Postman (e.g. ART001) for every line. */
    cloudFallbackArticleId?: string;
    /** Required when POS currency is EUR — sent as currency.exRate to easyPos cloud. */
    eurExchangeRate?: number;
  };
}

export interface PrinterProfileDTO {
  id: string; // stable id used by routing
  name: string;
  enabled?: boolean;
  mode?: 'NETWORK' | 'SYSTEM' | 'SERIAL';
  ip?: string;
  port?: number;
  deviceName?: string;
  silent?: boolean;
  systemRawEscpos?: boolean;
  serialPath?: string;
  baudRate?: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
}

export interface TableAreaDTO {
  name: string;
  count: number;
}

/**
 * Sidecar metadata attached to every print payload. The renderer pieces
 * this together when sending an order or a payment, the dispatcher
 * reads it to decide layout (header style, hide prices, station label),
 * and the api.ts /print/ticket route reads it to detect payments and
 * record anti-theft signals. Keep this list in sync with what
 * `OrderPage.tsx` actually sends.
 */
export interface TicketPrintMeta {
  // What kind of slip this is. Affects header style + which side effects fire.
  kind?: 'ORDER' | 'PAYMENT' | 'RECEIPT';
  // Originating user (used for notifications + anti-theft attribution).
  userId?: number;
  // Optional station hint set by the routing splitter ("KITCHEN" | "BAR" | "ALL").
  station?: string;
  // Human label for routed-order slips ("food", "drinks", etc.).
  routeLabel?: string;
  // Suppress money columns on order slips that go to the kitchen.
  hidePrices?: boolean;
  // Default true; set false for VAT-exempt receipts.
  vatEnabled?: boolean;

  // ---- Payment metadata (only on kind === 'PAYMENT') ----------------
  method?: string;
  paymentMethod?: string;
  paidAt?: string;
  totalBefore?: number;
  totalAfter?: number;
  total?: number;

  // ---- Discount metadata (only when a discount was applied) ---------
  discountType?: 'PERCENT' | 'AMOUNT';
  discountValue?: number;
  discountAmount?: number;
  discountReason?: string;
  managerApprovedByName?: string;

  // ---- Service charge metadata --------------------------------------
  serviceChargeEnabled?: boolean;
  serviceChargeApplied?: boolean;
  serviceChargeMode?: 'PERCENT' | 'AMOUNT';
  serviceChargeValue?: number;
  serviceChargeAmount?: number;

  // ---- Fiscal metadata (only when fiskalizimi is enabled) ------------
  fiscalEnabled?: boolean;
  fiscalNslf?: string;
  fiscalNivf?: string;
  fiscalLink?: string;
}

export const LoginWithPinInputSchema = z.object({
  pin: z.string().min(4).max(6),
  userId: z.number().optional(),
  pairingCode: z.string().min(4).max(12).optional(),
});
export type LoginWithPinInput = z.infer<typeof LoginWithPinInputSchema>;

export const CreateUserInputSchema = z.object({
  displayName: z.string().min(1),
  role: z.enum([
    'ADMIN',
    'CASHIER',
    'WAITER',
    'KP',
    'CHEF',
    'HEAD_CHEF',
    'FOOD_RUNNER',
    'HOST',
    'BUSSER',
    'BARTENDER',
    'BARBACK',
    'CLEANER',
  ]),
  pin: z.string().min(4).max(6),
  active: z.boolean().optional().default(true),
});
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z.object({
  id: z.number(),
  displayName: z.string().min(1).optional(),
  role: z
    .enum([
      'ADMIN',
      'CASHIER',
      'WAITER',
      'KP',
      'CHEF',
      'HEAD_CHEF',
      'FOOD_RUNNER',
      'HOST',
      'BUSSER',
      'BARTENDER',
      'BARBACK',
      'CLEANER',
    ])
    .optional(),
  pin: z.string().min(4).max(6).optional(),
  active: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;

export const DeleteUserInputSchema = z.object({
  id: z.number(),
  hard: z.boolean().optional().default(false),
});
export type DeleteUserInput = z.infer<typeof DeleteUserInputSchema>;

export const SetPrinterInputSchema = z.object({
  mode: z.enum(['NETWORK', 'SYSTEM', 'SERIAL']).optional(),
  ip: z
    .string()
    .regex(/^\d{1,3}(?:\.\d{1,3}){3}$/u, 'Invalid IPv4 address')
    .optional(),
  port: z.number().int().positive().optional(),
  deviceName: z.string().min(1).optional(),
  silent: z.boolean().optional(),
  systemRawEscpos: z.boolean().optional(),
  serialPath: z.string().min(1).optional(),
  baudRate: z.number().int().positive().optional(),
  dataBits: z.union([z.literal(7), z.literal(8)]).optional(),
  stopBits: z.union([z.literal(1), z.literal(2)]).optional(),
  parity: z.enum(['none', 'even', 'odd']).optional(),
  usbVendorId: z.number().int().optional(),
  usbProductId: z.number().int().optional(),
});
export type SetPrinterInput = z.infer<typeof SetPrinterInputSchema>;

export interface SystemPrinterDTO {
  name: string;
  isDefault?: boolean;
  status?: number;
  description?: string;
}

// Menu DTOs and contracts
export interface MenuItemDTO {
  id: number;
  name: string;
  sku: string;
  price: number;
  vatRate: number;
  active: boolean;
  categoryId: number;
  isKg?: boolean;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
  /** OK = normal; LOW = yellow warning; OUT = unavailable on waiter menu. */
  stockLevel?: 'OK' | 'LOW' | 'OUT';
  /** Whole units left today while LOW (optional legacy warning-only LOW when omitted). */
  stockRemaining?: number | null;
}

export interface MenuCategoryDTO {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  color?: string | null;
  items: MenuItemDTO[];
}

export const CreateMenuCategoryInputSchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().min(0).optional(),
  color: z.string().optional().nullable(),
  active: z.boolean().optional(),
});
export type CreateMenuCategoryInput = z.infer<
  typeof CreateMenuCategoryInputSchema
>;

export const UpdateMenuCategoryInputSchema = z.object({
  id: z.number(),
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().min(0).optional(),
  color: z.string().optional().nullable(),
  active: z.boolean().optional(),
});
export type UpdateMenuCategoryInput = z.infer<
  typeof UpdateMenuCategoryInputSchema
>;

export const CreateMenuItemInputSchema = z.object({
  categoryId: z.number(),
  name: z.string().min(1),
  sku: z.string().optional(),
  price: z.number().nonnegative(),
  vatRate: z.number().min(0).max(1).optional(),
  active: z.boolean().optional(),
  isKg: z.boolean().optional(),
  station: z.enum(['KITCHEN', 'BAR', 'DESSERT']).optional(),
  stockLevel: z.enum(['OK', 'LOW', 'OUT']).optional(),
  stockRemaining: z.coerce.number().int().min(0).optional().nullable(),
});
export type CreateMenuItemInput = z.infer<typeof CreateMenuItemInputSchema>;

export const UpdateMenuItemInputSchema = z.object({
  id: z.number(),
  categoryId: z.number().optional(),
  name: z.string().min(1).optional(),
  price: z.number().nonnegative().optional(),
  vatRate: z.number().min(0).max(1).optional(),
  active: z.boolean().optional(),
  isKg: z.boolean().optional(),
  station: z.enum(['KITCHEN', 'BAR', 'DESSERT']).optional(),
  stockLevel: z.enum(['OK', 'LOW', 'OUT']).optional(),
  stockRemaining: z.coerce.number().int().min(0).optional().nullable(),
});
export type UpdateMenuItemInput = z.infer<typeof UpdateMenuItemInputSchema>;

export interface ApiMenu {
  listCategoriesWithItems(): Promise<MenuCategoryDTO[]>;
  createCategory(input: CreateMenuCategoryInput): Promise<{ id: number }>;
  updateCategory(input: UpdateMenuCategoryInput): Promise<boolean>;
  deleteCategory(id: number): Promise<boolean>;
  createItem(input: CreateMenuItemInput): Promise<{ id: number; sku: string }>;
  updateItem(input: UpdateMenuItemInput): Promise<boolean>;
  deleteItem(id: number): Promise<boolean>;
}

export interface ApiAuth {
  loginWithPin(
    pin: string,
    userId?: number,
    pairingCode?: string,
  ): Promise<UserDTO | null>;
  verifyManagerPin(pin: string): Promise<{
    ok: boolean;
    userId?: number;
    userName?: string;
    // Short-lived token proving manager/admin approval.
    approvalToken?: string;
  }>;
  logoutAdmin(): Promise<boolean>;
  createUser(input: CreateUserInput): Promise<UserDTO>;
  listUsers(input?: { includeAdmins?: boolean }): Promise<UserDTO[]>;
  updateUser(input: UpdateUserInput): Promise<UserDTO>;
  syncStaffFromApi(url?: string): Promise<number>;
  deleteUser(input: DeleteUserInput): Promise<boolean>;
}

export interface ApiNetwork {
  getIps(): Promise<string[]>;
}

export interface ApiRequests {
  create(input: {
    requesterId: number;
    ownerId: number;
    area: string;
    tableLabel: string;
    items: any[];
    note?: string | null;
  }): Promise<boolean>;
  listForOwner(ownerId: number): Promise<
    Array<{
      id: number;
      area: string;
      tableLabel: string;
      requesterId: number;
      items: any[];
      note?: string | null;
      createdAt: string;
    }>
  >;
  approve(id: number, ownerId: number): Promise<boolean>;
  reject(id: number, ownerId: number): Promise<boolean>;
  pollApprovedForTable(
    ownerId: number,
    area: string,
    tableLabel: string,
  ): Promise<Array<{ id: number; items: any[]; note?: string | null }>>;
  markApplied(ids: number[]): Promise<boolean>;
}

// Shifts
export interface ShiftDTO {
  id: number;
  openedAt: string;
  closedAt?: string | null;
  openedById: number;
  closedById?: number | null;
}

/**
 * Returned when `clockOut` is refused because the waiter still owns
 * tables that are open on the floor. The renderer should toast the
 * `error` message and keep the user logged in so they can close or
 * transfer the listed tables before clocking out.
 */
export interface ClockOutBlockedDTO {
  ok: false;
  error: string;
  code: 'OPEN_TABLES_OWNED';
  openTables: { area: string; label: string }[];
}

export interface ApiShifts {
  getOpen(userId: number): Promise<ShiftDTO | null>;
  clockIn(userId: number): Promise<ShiftDTO>;
  clockOut(userId: number): Promise<ShiftDTO | ClockOutBlockedDTO | null>;
  listOpen(): Promise<number[]>; // userIds with open shifts
}

export interface ApiSettings {
  get(): Promise<SettingsDTO>;
  update(input: Partial<SettingsDTO>): Promise<SettingsDTO>;
  testPrint(): Promise<boolean>;
  setPrinter(input: SetPrinterInput): Promise<SettingsDTO>;
  testPrintVerbose?(): Promise<TestPrintResult>;
  // Print a Hello-World test payload to a specific profile WITHOUT touching
  // the saved settings — used by the "Test print" button on each profile
  // card so an admin can validate the printer config before saving.
  testPrintProfile?(profile: PrinterProfileDTO): Promise<TestPrintResult>;
  listPrinters?(): Promise<SystemPrinterDTO[]>;
  listSerialPorts?(): Promise<
    {
      path: string;
      manufacturer?: string;
      serialNumber?: string;
      vendorId?: string;
      productId?: string;
    }[]
  >;
  /** Ping the configured fiscal middleware (easyPos local API). */
  testFiscalConnection?(): Promise<{
    ok: boolean;
    message?: string;
    messageKey?: string;
  }>;
  getFiscalTokenHint?(): Promise<{
    configured: boolean;
    suffix?: string;
    tokenId?: string;
    deviceTail?: string;
  }>;
  testFiscalMinimalInvoice?(): Promise<{ ok: boolean; message?: string }>;
}

export type TestPrintResult = { ok: boolean; error?: string };

export interface ApiOffline {
  getStatus(): Promise<{ queued: number }>;
}

export type BillingState = 'ACTIVE' | 'PAST_DUE' | 'PAUSED';

export interface BillingStatusDTO {
  status: BillingState;
  currentPeriodEnd?: string | null;
  cancelAt?: string | null;
  cancelRequestedAt?: string | null;
  pausedAt?: string | null;
  message?: string | null;
  billingEnabled?: boolean;
}

export interface ApiBilling {
  getStatus(): Promise<BillingStatusDTO>;
  // Admin-only: refresh from Stripe (best-effort) so cancellations show immediately.
  getStatusLive?(): Promise<BillingStatusDTO>;
  createCheckoutSession(): Promise<{ url?: string; error?: string }>;
  createPortalSession?(): Promise<{ url?: string; error?: string }>;
}

export interface ApiSystem {
  openExternal(url: string): Promise<boolean>;
}

export interface Api {
  auth: ApiAuth;
  settings: ApiSettings;
  menu: ApiMenu;
  shifts: ApiShifts;
  admin: ApiAdmin;
  kds: ApiKds;
  backups: ApiBackups;
  reports: ApiReports;
  offline: ApiOffline;
  billing: ApiBilling;
  system: ApiSystem;
  layout: ApiLayout;
  covers: ApiCovers;
  tickets: ApiTickets;
  print: ApiPrint;
  notifications: ApiNotifications;
  tables: ApiTables;
  requests: ApiRequests;
  network: ApiNetwork;
  updater: ApiUpdater;
  reservations: ApiReservations;
}

export type ReservationStatus =
  | 'BOOKED'
  | 'SEATED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export interface ReservationDTO {
  id: number;
  area: string;
  tableLabel: string | null;
  customerName: string;
  customerPhone: string | null;
  partySize: number;
  startsAt: string; // ISO
  durationMin: number;
  note: string | null;
  status: ReservationStatus;
  createdById: number;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationCreateInput {
  area: string;
  tableLabel?: string | null;
  customerName: string;
  customerPhone?: string | null;
  partySize?: number;
  startsAtIso: string;
  durationMin?: number;
  note?: string | null;
  createdById: number;
  // Optional initial status. Defaults to BOOKED on the server. Used by the
  // walk-in / "Seat now" flow which creates the reservation already SEATED.
  status?: ReservationStatus;
}

export interface ReservationUpdateInput {
  id: number;
  // Required for authorization. The active host or admin id from the renderer.
  actorId: number;
  area?: string;
  tableLabel?: string | null;
  customerName?: string;
  customerPhone?: string | null;
  partySize?: number;
  startsAtIso?: string;
  durationMin?: number;
  note?: string | null;
}

export interface ApiReservations {
  openWindow(): Promise<boolean>;
  list(input: {
    dateIso: string; // any ISO inside the target local day
    area?: string;
  }): Promise<ReservationDTO[]>;
  create(input: ReservationCreateInput): Promise<ReservationDTO>;
  update(input: ReservationUpdateInput): Promise<ReservationDTO>;
  delete(input: { id: number; actorId: number }): Promise<boolean>;
  setStatus(input: {
    id: number;
    actorId: number;
    status: ReservationStatus;
  }): Promise<ReservationDTO>;
  listCounts(input: {
    startIso: string;
    endIso: string;
  }): Promise<Record<string, number>>;
}

export interface BackupFileDTO {
  name: string;
  bytes: number;
  createdAt: string;
}

export interface ApiBackups {
  list(): Promise<BackupFileDTO[]>;
  create(): Promise<{ ok: boolean; file?: string; error?: string }>;
  restore(input: {
    name: string;
  }): Promise<{ ok: boolean; error?: string; devRestartRequired?: boolean }>;
  uploadToCloud(input?: {
    name?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  syncFromCloud(): Promise<{
    usersSynced: number;
    menuItemsSynced: number;
    menuSynced: boolean;
    error?: string;
  }>;
}

export interface KdsTicketDTO {
  ticketId: number;
  orderNo: number;
  area: string;
  tableLabel: string;
  waiterName?: string | null;
  firedAt: string;
  bumpedAt?: string | null;
  note?: string | null;
  items: any[];
}

export interface ApiKds {
  openWindow(): Promise<boolean>;
  listTickets(input: {
    station: 'KITCHEN' | 'BAR' | 'DESSERT';
    status: 'NEW' | 'DONE';
    limit?: number;
  }): Promise<KdsTicketDTO[]>;
  bump(input: {
    station: 'KITCHEN' | 'BAR' | 'DESSERT';
    ticketId: number;
    userId?: number;
  }): Promise<boolean>;
  recall(input: {
    station: 'KITCHEN' | 'BAR' | 'DESSERT';
    ticketId?: number;
    itemIdx?: number;
  }): Promise<{
    ok: boolean;
    ticketId?: number | null;
    itemRecalled?: boolean;
  }>;
  bumpItem(input: {
    station: 'KITCHEN' | 'BAR' | 'DESSERT';
    ticketId: number;
    itemIdx: number;
    userId?: number;
  }): Promise<boolean>;
  clearDone(input: {
    station: 'KITCHEN' | 'BAR' | 'DESSERT';
  }): Promise<{ ok: boolean; purgedDoneRows: number }>;
  debug(): Promise<any>;
}

// Admin overview DTOs
export interface AdminOverviewDTO {
  activeUsers: number;
  openShifts: number;
  openOrders: number;
  lowStockItems: number;
  queuedPrintJobs: number;
  lastMenuSync?: string | null;
  lastStaffSync?: string | null;
  printerIp?: string | null;
  appVersion: string;
  revenueTodayNet?: number; // without VAT
  revenueTodayVat?: number; // VAT amount
  // Total guests served today across all tables. Computed from the most
  // recent cover count saved per (area, label) for the current day.
  coversToday?: number;
  // Reservations day-summary (today, local time). All fields are optional so
  // older clients keep working; renderer should default to 0.
  reservationsTotalToday?: number;
  reservationsCoversToday?: number; // sum of partySize across non-cancelled
  reservationsAvgPartyToday?: number; // covers / parties (rounded to 1 decimal)
  reservationsByStatusToday?: {
    BOOKED?: number;
    SEATED?: number;
    COMPLETED?: number;
    NO_SHOW?: number;
    CANCELLED?: number;
  };
  // Bookings still ahead of "now" today (BOOKED only).
  reservationsUpcomingToday?: number;
  // No-show rate today, expressed as percentage 0..100. Denominator is
  // reservations whose start time has already passed today (BOOKED + SEATED +
  // COMPLETED + NO_SHOW), so it doesn't punish bookings that haven't arrived.
  reservationsNoShowRateToday?: number;
  // Next BOOKED reservation today (after now), if any.
  nextReservationToday?: {
    timeIso: string;
    customerName: string;
    partySize: number;
    area: string;
    tableLabel: string | null;
  } | null;
}

export interface AdminShiftDTO {
  id: number;
  userId: number;
  userName: string;
  openedAt: string;
  closedAt: string | null;
  durationHours: number; // rounded to 2 decimals
  isOpen: boolean;
}

export interface SecurityLogEntry {
  timestamp: number;
  event: string;
  details: any;
}

export interface MemoryStats {
  current: { heapUsed: number; rss: number; timestamp: number };
  average: { heapUsed: number; rss: number };
  peak: { heapUsed: number; rss: number; timestamp: number };
  trend: 'increasing' | 'decreasing' | 'stable';
  formatted: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
    external: string;
  };
}

export interface ApiAdmin {
  getOverview(): Promise<AdminOverviewDTO>;
  openWindow(): Promise<boolean>;
  listShifts(input?: {
    startIso?: string;
    endIso?: string;
  }): Promise<AdminShiftDTO[]>;
  listTicketCounts(input?: { startIso?: string; endIso?: string }): Promise<
    {
      id: number;
      name: string;
      active: boolean;
      tickets: number;
      /** Number of tickets in the period whose log row was created by a transfer. */
      transfersIn: number;
    }[]
  >;
  listTicketsByUser(
    userId: number,
    range?: { startIso?: string; endIso?: string },
  ): Promise<AdminTicketDTO[]>;
  listNotifications(input?: {
    userId?: number;
    onlyUnread?: boolean;
    limit?: number;
  }): Promise<AdminNotificationDTO[]>;
  markAllNotificationsRead(input?: { userId?: number }): Promise<boolean>;
  getTopSellingToday(): Promise<TopSellingDTO | null>;
  getSalesTrends(input: {
    range: 'daily' | 'weekly' | 'monthly';
  }): Promise<SalesTrendDTO>;
  getSecurityLog(limit?: number): Promise<SecurityLogEntry[]>;
  getMemoryStats(): Promise<MemoryStats>;
  exportMemorySnapshot(): Promise<string>;
  /**
   * Aggregated business analytics for the Review tab. Computes KPIs, time-
   * series, top items, hour/weekday breakdowns, and per-waiter performance
   * for the requested period and (optionally) a comparison period.
   */
  getReview(input: ReviewRangeInput): Promise<ReviewDTO>;
}

// Waiter-facing reports (per-user)
export interface MyReportsOverviewDTO {
  revenueTodayNet: number;
  revenueTodayVat: number;
  openOrders: number;
}

/** Voided line items / ticket rows from `reports:listMyVoidedTickets`. */
export interface VoidedTicketReportDTO {
  kind: 'VOIDED_TICKET' | 'VOIDED_ITEMS';
  area: string;
  tableLabel: string;
  createdAt: string;
  note: string;
  userName?: string | null;
  covers?: number | null;
  items: {
    sku?: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate?: number;
    note?: string;
    voided?: boolean;
  }[];
  totalItems: number;
  voidedCount: number;
  subtotal: number;
  vat: number;
  total: number;
}

export interface ApiReports {
  getMyOverview(userId: number): Promise<MyReportsOverviewDTO>;
  getMyTopSellingToday(userId: number): Promise<TopSellingDTO | null>;
  getMySalesTrends(input: {
    userId: number;
    range: 'daily' | 'weekly' | 'monthly';
  }): Promise<SalesTrendDTO>;
  listMyActiveTickets(userId: number): Promise<ReportTicketDTO[]>;
  listMyPaidTickets(input: {
    userId: number;
    q?: string;
    limit?: number;
  }): Promise<ReportTicketDTO[]>;
  listMyVoidedTickets(input: {
    userId: number;
    limit?: number;
  }): Promise<VoidedTicketReportDTO[]>;
}

export interface ReportTicketDTO {
  kind: 'ACTIVE' | 'PAID';
  area: string;
  tableLabel: string;
  createdAt: string;
  paidAt?: string | null;
  covers?: number | null;
  note?: string | null;
  userName?: string | null;
  paymentMethod?:
    | 'CASH'
    | 'CARD'
    | 'GIFT_CARD'
    | 'ROOM_CHARGE'
    | 'MIXED'
    | null;
  vatEnabled?: boolean | null;
  serviceChargeEnabled?: boolean | null;
  serviceChargeApplied?: boolean | null;
  serviceChargeMode?: 'PERCENT' | 'AMOUNT' | null;
  serviceChargeValue?: number | null;
  serviceChargeAmount?: number | null;
  discountType?: 'NONE' | 'PERCENT' | 'AMOUNT' | null;
  discountValue?: number | null;
  discountAmount?: number | null;
  discountReason?: string | null;
  items: {
    sku?: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate?: number;
    note?: string;
    voided?: boolean;
  }[];
  subtotal: number;
  vat: number;
  total: number;
}

export interface AdminTicketDTO {
  id: number;
  area: string;
  tableLabel: string;
  covers: number | null;
  createdAt: string;
  items: {
    name: string;
    qty: number;
    unitPrice: number;
    vatRate?: number;
    note?: string;
    voided?: boolean;
  }[];
  note?: string | null;
  subtotal: number;
  vat: number;
  // Resolved on the main process by inspecting the ticket-log row, the
  // currently open tables map and recent payment receipts.
  // `TRANSFERRED` flags a row whose session was moved to another table
  // (revenue lives on the destination ticket — see
  // `TRANSFERRED_OUT_TAG_PREFIX`); the row is kept for audit purposes
  // but excluded from PAID counts/sums.
  status?: 'PAID' | 'VOIDED' | 'ACTIVE' | 'TRANSFERRED';
  /**
   * If the ticket-log row was produced by a table transfer this carries the
   * structured audit info parsed from the `[TRANSFER ...]` note tag. `MOVED`
   * means the table itself moved (and possibly changed owner); `OWNER` means
   * only the owning waiter changed.
   */
  transfer?: {
    kind: 'MOVED' | 'OWNER';
    fromUserId: number | null;
    fromUserName: string | null;
    fromArea: string | null;
    fromLabel: string | null;
    toUserId: number | null;
    toUserName: string | null;
    byUserId: number | null;
    byUserName: string | null;
  } | null;
}

export interface AdminNotificationDTO {
  id: number;
  userId: number;
  userName: string;
  type: 'SECURITY' | 'OTHER';
  message: string;
  readAt: string | null;
  createdAt: string;
}

export interface TopSellingDTO {
  name: string;
  qty: number;
  revenue: number;
}

export interface SalesPointDTO {
  label: string; // e.g., 08/12, 2025-W33, 2025-08
  total: number; // revenue without VAT
  orders: number; // number of tickets
}

export interface SalesTrendDTO {
  range: 'daily' | 'weekly' | 'monthly';
  points: SalesPointDTO[];
}

// =====================================================================
// Admin "Business Review" — analytics over arbitrary date ranges with
// optional period-over-period comparison.
// =====================================================================

export type ReviewGranularity = 'day' | 'month' | 'year';

export interface ReviewRangeInput {
  /** Start of the primary period, ISO. */
  currentStartIso: string;
  /** End of the primary period, ISO (inclusive). */
  currentEndIso: string;
  /** Optional comparison period start, ISO. */
  compareStartIso?: string | null;
  /** Optional comparison period end, ISO (inclusive). */
  compareEndIso?: string | null;
  /** Bucket size for the time-series chart. */
  granularity: ReviewGranularity;
}

export interface ReviewSummaryDTO {
  startIso: string;
  endIso: string;
  /** Net revenue (sum of unitPrice * qty for non-voided lines). */
  revenueNet: number;
  /** Estimated VAT (sum of unitPrice * qty * vatRate for non-voided lines). */
  revenueVat: number;
  /** Number of TicketLog rows in the period (proxy for "ticket sends"). */
  orders: number;
  /** Number of non-voided line items. */
  items: number;
  /** Sum of `covers` across rows that recorded covers. */
  covers: number;
  /** revenueNet / orders, 0 when no orders. */
  avgTicket: number;
  /** items / orders, 0 when no orders. */
  avgItemsPerTicket: number;
  /** Distinct (area, tableLabel) pairs touched. */
  uniqueTables: number;
  /** Distinct waiter ids that produced at least one row. */
  uniqueWaiters: number;
  /** Number of rows whose entire item list was voided (best-effort). */
  voidedTickets: number;
}

export interface ReviewSeriesPointDTO {
  /** Bucket label, e.g. `04/30`, `2026-05`, `2026`. */
  label: string;
  /** Bucket start, ISO — used to align current vs compare on the same x axis. */
  bucketIso: string;
  revenue: number;
  orders: number;
}

export interface ReviewWaiterDTO {
  userId: number;
  name: string;
  role: string;
  active: boolean;
  orders: number;
  items: number;
  revenue: number;
  covers: number;
  avgTicket: number;
  /** Total hours across DayShift rows that overlap the period. */
  hoursWorked: number;
  /** revenue / max(hoursWorked, 1). */
  revenuePerHour: number;
}

export interface ReviewTopItemDTO {
  name: string;
  qty: number;
  revenue: number;
}

export interface ReviewHourBucketDTO {
  /** 0..23 (local time of the device). */
  hour: number;
  orders: number;
  revenue: number;
}

export interface ReviewWeekdayBucketDTO {
  /** 0..6 with 0 = Sunday. */
  dayOfWeek: number;
  orders: number;
  revenue: number;
}

export interface ReviewDTO {
  granularity: ReviewGranularity;
  current: ReviewSummaryDTO;
  /** Present only when a comparison range was requested. */
  compare: ReviewSummaryDTO | null;
  series: {
    current: ReviewSeriesPointDTO[];
    compare: ReviewSeriesPointDTO[] | null;
  };
  topItems: ReviewTopItemDTO[];
  waiters: ReviewWaiterDTO[];
  hourly: ReviewHourBucketDTO[];
  weekday: ReviewWeekdayBucketDTO[];
}

// Table layout
export type TableLayoutNode =
  | {
      id: number;
      kind?: 'TABLE';
      label: string;
      x: number;
      y: number;
      status: 'FREE' | 'OCCUPIED' | 'RESERVED' | 'SERVED';
    }
  | {
      id: number;
      kind: 'AREA';
      label: string;
      x: number;
      y: number;
      w: number;
      h: number;
    };
export interface ApiLayout {
  // `scope` namespaces the saved layout. Defaults to "pos" (waiter view) so
  // existing callers stay compatible. The reservation panel uses "host" so
  // hosts and waiters maintain independent floor layouts.
  get(
    userId: number,
    area: string,
    scope?: string,
  ): Promise<TableLayoutNode[] | null>;
  save(
    userId: number,
    area: string,
    nodes: TableLayoutNode[],
    scope?: string,
  ): Promise<boolean>;
}

export interface ApiCovers {
  save(area: string, label: string, covers: number): Promise<boolean>;
  getLast(area: string, label: string): Promise<number | null>;
}

declare global {
  interface Window {
    api: Api;
  }
}

/**
 * Per-printer pending retry as exposed to the renderer. Mirrors the
 * subset of the `PrintJob` row that's safe to surface in a UI list —
 * no payload contents (those can be huge), no arbitrary timestamps in
 * native form (always ISO strings).
 */
export interface PendingPrintRetryDTO {
  id: number;
  status: 'RETRY' | 'FAILED';
  type: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  printerProfileId: string | null;
  createdAt: string;
}

export interface ApiPrint {
  /** List the latest 100 RETRY + FAILED rows for a future admin UI. */
  listRetries(): Promise<PendingPrintRetryDTO[]>;
  /** Force-fail a row so it stops retrying. */
  cancelRetry(id: number): Promise<{ ok: boolean; error?: string }>;
}

export interface ApiTickets {
  log(input: {
    userId: number;
    area: string;
    tableLabel: string;
    covers: number | null;
    items: {
      sku?: string;
      name: string;
      qty: number;
      unitPrice: number;
      vatRate?: number;
      note?: string;
    }[];
    note?: string | null;
  }): Promise<boolean>;
  getLatestForTable(
    area: string,
    tableLabel: string,
  ): Promise<{
    items: {
      name: string;
      qty: number;
      unitPrice: number;
      vatRate?: number;
      note?: string;
    }[];
    note?: string | null;
    covers?: number | null;
    createdAt: string;
    userId: number;
  } | null>;
  voidItem(input: {
    userId: number;
    area: string;
    tableLabel: string;
    item: {
      name: string;
      qty?: number;
      unitPrice: number;
      vatRate?: number;
      note?: string;
    };
  }): Promise<boolean>;
  voidTicket(input: {
    userId: number;
    area: string;
    tableLabel: string;
    reason?: string;
  }): Promise<boolean>;
  getTableTooltip(
    area: string,
    tableLabel: string,
  ): Promise<{
    covers: number | null;
    firstAt: string | null;
    total: number;
  } | null>;
  print(input: PrintTicketInput): Promise<boolean>;
}

export interface PrintTicketInput {
  area: string;
  tableLabel: string;
  covers?: number | null;
  items: {
    sku?: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate?: number;
    note?: string;
    station?: 'KITCHEN' | 'BAR' | 'DESSERT';
    categoryId?: number;
    categoryName?: string;
  }[];
  note?: string | null;
  userName?: string;
  // When true, store a receipt snapshot for history but don't actually print.
  recordOnly?: boolean;
  // Optional metadata used for reporting/attribution (e.g., payment receipts).
  meta?: any;
}

export interface NotificationDTO {
  id: number;
  type: 'SECURITY' | 'OTHER';
  message: string;
  readAt: string | null;
  createdAt: string;
}

export interface ApiNotifications {
  list(userId: number, onlyUnread?: boolean): Promise<NotificationDTO[]>;
  markAllRead(userId: number): Promise<boolean>;
}

export interface ApiTables {
  setOpen(area: string, label: string, open: boolean): Promise<boolean>;
  listOpen(): Promise<{ area: string; label: string }[]>;
  transfer(input: TransferTableInput): Promise<TransferTableResult>;
}

export const TransferTableInputSchema = z.object({
  fromArea: z.string().min(1),
  fromLabel: z.string().min(1),
  toArea: z.string().min(1).optional().nullable(),
  toLabel: z.string().min(1).optional().nullable(),
  toUserId: z.number().int().positive().optional().nullable(),
  actorUserId: z.number().int().positive(),
  /** When in cloud mode, actor may not exist in local DB; pass role from session to bypass lookup */
  actorRole: z.string().optional(),
  idempotencyKey: z.string().min(8).max(200).optional().nullable(),
});
export type TransferTableInput = z.infer<typeof TransferTableInputSchema>;
export type TransferTableResult = { ok: true } | { ok: false; error: string };

export interface UpdateStatusDTO {
  hasUpdate: boolean;
  updateInfo: {
    version: string;
    releaseDate: string | null;
    releaseNotes: string;
  } | null;
  downloaded: boolean;
  checking: boolean;
}

export interface ApiUpdater {
  getUpdateStatus(): Promise<UpdateStatusDTO>;
  checkForUpdates(): Promise<{ success?: boolean; error?: string }>;
  downloadUpdate(): Promise<{ success?: boolean; error?: string }>;
  installUpdate(): Promise<{ success?: boolean; error?: string }>;
}
