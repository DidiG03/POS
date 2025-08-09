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
}

export const LoginWithPinInputSchema = z.object({ pin: z.string().min(4).max(6) });
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

export interface ApiAuth {
  loginWithPin(pin: string): Promise<UserDTO | null>;
  createUser(input: CreateUserInput): Promise<UserDTO>;
  listUsers(): Promise<UserDTO[]>;
  updateUser(input: UpdateUserInput): Promise<UserDTO>;
}

export interface ApiSettings {
  get(): Promise<SettingsDTO>;
  update(input: Partial<SettingsDTO>): Promise<SettingsDTO>;
  testPrint(): Promise<boolean>;
  setPrinter(input: SetPrinterInput): Promise<SettingsDTO>;
}

export interface Api {
  auth: ApiAuth;
  settings: ApiSettings;
}


