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
  currency: string;
  defaultVatRate: number;
  preferences?: {
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

export const LoginWithPinInputSchema = z.object({
  pin: z.string().min(4).max(6),
  userId: z.number().optional(),
  pairingCode: z.string().min(4).max(12).optional(),
});
export type LoginWithPinInput = z.infer<typeof LoginWithPinInputSchema>;

export const CreateUserInputSchema = z.object({
  displayName: z.string().min(1),
  role: z.enum(['ADMIN', 'CASHIER', 'WAITER', 'KP', 'CHEF', 'HEAD_CHEF', 'FOOD_RUNNER', 'HOST', 'BUSSER', 'BARTENDER', 'BARBACK', 'CLEANER']),
  pin: z.string().min(4).max(6),
  active: z.boolean().optional().default(true),
});
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z.object({
  id: z.number(),
  displayName: z.string().min(1).optional(),
  role: z.enum(['ADMIN', 'CASHIER', 'WAITER', 'KP', 'CHEF', 'HEAD_CHEF', 'FOOD_RUNNER', 'HOST', 'BUSSER', 'BARTENDER', 'BARBACK', 'CLEANER']).optional(),
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
export type CreateMenuCategoryInput = z.infer<typeof CreateMenuCategoryInputSchema>;

export const UpdateMenuCategoryInputSchema = z.object({
  id: z.number(),
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().min(0).optional(),
  color: z.string().optional().nullable(),
  active: z.boolean().optional(),
});
export type UpdateMenuCategoryInput = z.infer<typeof UpdateMenuCategoryInputSchema>;

export const CreateMenuItemInputSchema = z.object({
  categoryId: z.number(),
  name: z.string().min(1),
  sku: z.string().optional(),
  price: z.number().nonnegative(),
  vatRate: z.number().min(0).max(1).optional(),
  active: z.boolean().optional(),
  isKg: z.boolean().optional(),
  station: z.enum(['KITCHEN', 'BAR', 'DESSERT']).optional(),
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
  loginWithPin(pin: string, userId?: number, pairingCode?: string): Promise<UserDTO | null>;
  verifyManagerPin(pin: string): Promise<{ ok: boolean; userId?: number; userName?: string }>;
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
  create(input: { requesterId: number; ownerId: number; area: string; tableLabel: string; items: any[]; note?: string | null }): Promise<boolean>;
  listForOwner(ownerId: number): Promise<Array<{ id: number; area: string; tableLabel: string; requesterId: number; items: any[]; note?: string | null; createdAt: string }>>;
  approve(id: number, ownerId: number): Promise<boolean>;
  reject(id: number, ownerId: number): Promise<boolean>;
  pollApprovedForTable(ownerId: number, area: string, tableLabel: string): Promise<Array<{ id: number; items: any[]; note?: string | null }>>;
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

export interface ApiShifts {
  getOpen(userId: number): Promise<ShiftDTO | null>;
  clockIn(userId: number): Promise<ShiftDTO>;
  clockOut(userId: number): Promise<ShiftDTO | null>;
  listOpen(): Promise<number[]>; // userIds with open shifts
}

export interface ApiSettings {
  get(): Promise<SettingsDTO>;
  update(input: Partial<SettingsDTO>): Promise<SettingsDTO>;
  testPrint(): Promise<boolean>;
  setPrinter(input: SetPrinterInput): Promise<SettingsDTO>;
  testPrintVerbose?(): Promise<TestPrintResult>;
  listPrinters?(): Promise<SystemPrinterDTO[]>;
  listSerialPorts?(): Promise<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }[]>;
}

export type TestPrintResult = { ok: boolean; error?: string };

export interface ApiOffline {
  getStatus(): Promise<{ queued: number }>;
}

export type BillingState = 'ACTIVE' | 'PAST_DUE' | 'PAUSED';

export interface BillingStatusDTO {
  status: BillingState;
  currentPeriodEnd?: string | null;
  message?: string | null;
  billingEnabled?: boolean;
}

export interface ApiBilling {
  getStatus(): Promise<BillingStatusDTO>;
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
  notifications: ApiNotifications;
  tables: ApiTables;
  requests: ApiRequests;
  network: ApiNetwork;
  updater: ApiUpdater;
}

export interface BackupFileDTO {
  name: string;
  bytes: number;
  createdAt: string;
}

export interface ApiBackups {
  list(): Promise<BackupFileDTO[]>;
  create(): Promise<{ ok: boolean; file?: string; error?: string }>;
  restore(input: { name: string }): Promise<{ ok: boolean; error?: string; devRestartRequired?: boolean }>;
}

export interface KdsTicketDTO {
  ticketId: number;
  orderNo: number;
  area: string;
  tableLabel: string;
  firedAt: string;
  bumpedAt?: string | null;
  note?: string | null;
  items: any[];
}

export interface ApiKds {
  openWindow(): Promise<boolean>;
  listTickets(input: { station: 'KITCHEN' | 'BAR' | 'DESSERT'; status: 'NEW' | 'DONE'; limit?: number }): Promise<KdsTicketDTO[]>;
  bump(input: { station: 'KITCHEN' | 'BAR' | 'DESSERT'; ticketId: number; userId?: number }): Promise<boolean>;
  bumpItem(input: { station: 'KITCHEN' | 'BAR' | 'DESSERT'; ticketId: number; itemIdx: number; userId?: number }): Promise<boolean>;
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
  formatted: { heapUsed: string; heapTotal: string; rss: string; external: string };
}

export interface ApiAdmin {
  getOverview(): Promise<AdminOverviewDTO>;
  openWindow(): Promise<boolean>;
  listShifts(input?: { startIso?: string; endIso?: string }): Promise<AdminShiftDTO[]>;
  listTicketCounts(input?: { startIso?: string; endIso?: string }): Promise<{ id: number; name: string; active: boolean; tickets: number }[]>;
  listTicketsByUser(userId: number, range?: { startIso?: string; endIso?: string }): Promise<AdminTicketDTO[]>;
  listNotifications(input?: { onlyUnread?: boolean; limit?: number }): Promise<AdminNotificationDTO[]>;
  markAllNotificationsRead(): Promise<boolean>;
  getTopSellingToday(): Promise<TopSellingDTO | null>;
  getSalesTrends(input: { range: 'daily' | 'weekly' | 'monthly' }): Promise<SalesTrendDTO>;
  getSecurityLog(limit?: number): Promise<SecurityLogEntry[]>;
  getMemoryStats(): Promise<MemoryStats>;
  exportMemorySnapshot(): Promise<string>;
}

// Waiter-facing reports (per-user)
export interface MyReportsOverviewDTO {
  revenueTodayNet: number;
  revenueTodayVat: number;
  openOrders: number;
}

export interface ApiReports {
  getMyOverview(userId: number): Promise<MyReportsOverviewDTO>;
  getMyTopSellingToday(userId: number): Promise<TopSellingDTO | null>;
  getMySalesTrends(input: { userId: number; range: 'daily' | 'weekly' | 'monthly' }): Promise<SalesTrendDTO>;
  listMyActiveTickets(userId: number): Promise<ReportTicketDTO[]>;
  listMyPaidTickets(input: { userId: number; q?: string; limit?: number }): Promise<ReportTicketDTO[]>;
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
  paymentMethod?: 'CASH' | 'CARD' | 'GIFT_CARD' | 'ROOM_CHARGE' | 'MIXED' | null;
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
  items: { sku?: string; name: string; qty: number; unitPrice: number; vatRate?: number; note?: string; voided?: boolean }[];
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
  items: { name: string; qty: number; unitPrice: number; vatRate?: number; note?: string; voided?: boolean }[];
  note?: string | null;
  subtotal: number;
  vat: number;
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

// Table layout
export type TableLayoutNode =
  | { id: number; kind?: 'TABLE'; label: string; x: number; y: number; status: 'FREE' | 'OCCUPIED' | 'RESERVED' | 'SERVED' }
  | { id: number; kind: 'AREA'; label: string; x: number; y: number; w: number; h: number };
export interface ApiLayout {
  get(userId: number, area: string): Promise<TableLayoutNode[] | null>;
  save(userId: number, area: string, nodes: TableLayoutNode[]): Promise<boolean>;
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

export interface ApiTickets {
  log(input: { userId: number; area: string; tableLabel: string; covers: number | null; items: { sku?: string; name: string; qty: number; unitPrice: number; vatRate?: number; note?: string }[]; note?: string | null }): Promise<boolean>;
  getLatestForTable(area: string, tableLabel: string): Promise<{
    items: { name: string; qty: number; unitPrice: number; vatRate?: number; note?: string }[];
    note?: string | null;
    covers?: number | null;
    createdAt: string;
    userId: number;
  } | null>;
  voidItem(input: { userId: number; area: string; tableLabel: string; item: { name: string; qty?: number; unitPrice: number; vatRate?: number; note?: string } }): Promise<boolean>;
  voidTicket(input: { userId: number; area: string; tableLabel: string; reason?: string }): Promise<boolean>;
  getTableTooltip(area: string, tableLabel: string): Promise<{ covers: number | null; firstAt: string | null; total: number } | null>;
  print(input: PrintTicketInput): Promise<boolean>;
}

export interface PrintTicketInput {
  area: string;
  tableLabel: string;
  covers?: number | null;
  items: { sku?: string; name: string; qty: number; unitPrice: number; vatRate?: number; note?: string; station?: 'KITCHEN' | 'BAR' | 'DESSERT'; categoryId?: number; categoryName?: string }[];
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


