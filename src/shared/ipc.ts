import { z } from 'zod';

export type UserRole = 'ADMIN' | 'CASHIER' | 'WAITER';

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
  printer?: {
    ip?: string;
    port?: number;
    usbVendorId?: number;
    usbProductId?: number;
  };
  enableAdmin?: boolean;
  tableCountMainHall?: number;
  tableCountTerrace?: number;
  tableAreas?: TableAreaDTO[];
}

export interface TableAreaDTO {
  name: string;
  count: number;
}

export const LoginWithPinInputSchema = z.object({
  pin: z.string().min(4).max(6),
  userId: z.number().optional(),
});
export type LoginWithPinInput = z.infer<typeof LoginWithPinInputSchema>;

export const CreateUserInputSchema = z.object({
  displayName: z.string().min(1),
  role: z.enum(['ADMIN', 'CASHIER', 'WAITER']),
  pin: z.string().min(4).max(6),
  active: z.boolean().optional().default(true),
});
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z.object({
  id: z.number(),
  displayName: z.string().min(1).optional(),
  role: z.enum(['ADMIN', 'CASHIER', 'WAITER']).optional(),
  pin: z.string().min(4).max(6).optional(),
  active: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;

export const SetPrinterInputSchema = z.object({
  ip: z
    .string()
    .regex(/^\d{1,3}(?:\.\d{1,3}){3}$/u, 'Invalid IPv4 address')
    .optional(),
  port: z.number().int().positive().optional(),
  usbVendorId: z.number().int().optional(),
  usbProductId: z.number().int().optional(),
});
export type SetPrinterInput = z.infer<typeof SetPrinterInputSchema>;

// Menu DTOs and contracts
export interface MenuItemDTO {
  id: number;
  name: string;
  sku: string;
  price: number;
  vatRate: number;
  active: boolean;
  categoryId: number;
}

export interface MenuCategoryDTO {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  items: MenuItemDTO[];
}

export const SyncMenuFromUrlInputSchema = z.object({ url: z.string().url(), lang: z.string().optional() });
export type SyncMenuFromUrlInput = z.infer<typeof SyncMenuFromUrlInputSchema>;

export interface ApiMenu {
  syncFromUrl(input: SyncMenuFromUrlInput): Promise<{ categories: number; items: number }>;
  listCategoriesWithItems(): Promise<MenuCategoryDTO[]>;
}

export interface ApiAuth {
  loginWithPin(pin: string, userId?: number): Promise<UserDTO | null>;
  createUser(input: CreateUserInput): Promise<UserDTO>;
  listUsers(): Promise<UserDTO[]>;
  updateUser(input: UpdateUserInput): Promise<UserDTO>;
  syncStaffFromApi(url?: string): Promise<number>;
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
}

export type TestPrintResult = { ok: boolean; error?: string };

export interface Api {
  auth: ApiAuth;
  settings: ApiSettings;
  menu: ApiMenu;
  shifts: ApiShifts;
  admin: ApiAdmin;
  layout: ApiLayout;
  covers: ApiCovers;
  tickets: ApiTickets;
  notifications: ApiNotifications;
  tables: ApiTables;
  requests: ApiRequests;
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

export interface ApiAdmin {
  getOverview(): Promise<AdminOverviewDTO>;
  openWindow(): Promise<boolean>;
  listShifts(): Promise<AdminShiftDTO[]>;
  listTicketCounts(input?: { startIso?: string; endIso?: string }): Promise<{ id: number; name: string; active: boolean; tickets: number }[]>;
  listTicketsByUser(userId: number, range?: { startIso?: string; endIso?: string }): Promise<AdminTicketDTO[]>;
  listNotifications(input?: { onlyUnread?: boolean; limit?: number }): Promise<AdminNotificationDTO[]>;
  markAllNotificationsRead(): Promise<boolean>;
  getTopSellingToday(): Promise<TopSellingDTO | null>;
  getSalesTrends(input: { range: 'daily' | 'weekly' | 'monthly' }): Promise<SalesTrendDTO>;
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
export type TableLayoutNode = { id: number; label: string; x: number; y: number; status: 'FREE' | 'OCCUPIED' | 'RESERVED' | 'SERVED' };
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
  log(input: { userId: number; area: string; tableLabel: string; covers: number | null; items: { name: string; qty: number; unitPrice: number; vatRate?: number; note?: string }[]; note?: string | null }): Promise<boolean>;
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
  items: { name: string; qty: number; unitPrice: number; vatRate?: number; note?: string }[];
  note?: string | null;
  userName?: string;
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
}


