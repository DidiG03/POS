/**
 * Security utilities for the POS system
 * 
 * Includes:
 * - Rate limiting for IPC handlers
 * - Input sanitization
 * - Security audit logging
 * - PIN validation
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';

// Rate limiting for IPC handlers (in-memory, per sender)
const ipcRateLimits = new Map<number, Map<string, { count: number; resetAt: number }>>();

export interface RateLimitOptions {
  maxAttempts?: number; // Max attempts per window
  windowMs?: number; // Time window in milliseconds
}

/**
 * Rate limit IPC handler calls
 * Returns true if allowed, false if rate limited
 */
export function checkRateLimit(
  event: IpcMainInvokeEvent,
  handlerName: string,
  options: RateLimitOptions = {},
): boolean {
  const { maxAttempts = 10, windowMs = 60 * 1000 } = options; // Default: 10 attempts per minute
  const senderId = event.sender.id;
  const now = Date.now();

  // Get or create rate limit map for this sender
  if (!ipcRateLimits.has(senderId)) {
    ipcRateLimits.set(senderId, new Map());
  }
  const senderLimits = ipcRateLimits.get(senderId)!;

  // Get or create rate limit entry for this handler
  const limitKey = handlerName;
  const current = senderLimits.get(limitKey);

  if (!current || current.resetAt <= now) {
    // Reset window
    senderLimits.set(limitKey, { count: 1, resetAt: now + windowMs });
    // Clean up old entries periodically
    cleanupOldRateLimits();
    return true;
  }

  if (current.count >= maxAttempts) {
    // Rate limited
    logSecurityEvent('rate_limit_exceeded', {
      senderId,
      handler: handlerName,
      count: current.count,
    });
    return false;
  }

  // Increment counter
  current.count += 1;
  senderLimits.set(limitKey, current);
  return true;
}

/**
 * Clean up rate limit entries for closed windows
 */
function cleanupOldRateLimits(): void {
  const now = Date.now();
  for (const [senderId, limits] of ipcRateLimits.entries()) {
    for (const [key, value] of limits.entries()) {
      if (value.resetAt <= now) {
        limits.delete(key);
      }
    }
    if (limits.size === 0) {
      ipcRateLimits.delete(senderId);
    }
  }
}

// Clean up every 5 minutes
setInterval(cleanupOldRateLimits, 5 * 60 * 1000);

/**
 * Clean up rate limits when a window is closed
 */
export function cleanupSenderRateLimits(senderId: number): void {
  ipcRateLimits.delete(senderId);
}

// Security audit log (in-memory, last 1000 events)
const securityLog: Array<{
  timestamp: number;
  event: string;
  details: any;
}> = [];
const MAX_LOG_SIZE = 1000;

/**
 * Log security events for audit trail
 */
export function logSecurityEvent(event: string, details: any): void {
  const entry = {
    timestamp: Date.now(),
    event,
    details,
  };
  securityLog.push(entry);

  // Keep only last MAX_LOG_SIZE entries
  if (securityLog.length > MAX_LOG_SIZE) {
    securityLog.shift();
  }

  // Also log to console in development
  if (process.env.NODE_ENV !== 'production') {
    console.warn('[Security Event]', event, details);
  }
}

/**
 * Get security audit log (for admin review)
 */
export function getSecurityLog(limit = 100): Array<{ timestamp: number; event: string; details: any }> {
  return securityLog.slice(-limit);
}

/**
 * Sanitize string input to prevent XSS
 * Removes potentially dangerous characters and HTML tags
 */
export function sanitizeString(input: string | null | undefined, maxLength = 500): string {
  if (!input) return '';
  let sanitized = String(input)
    .trim()
    .slice(0, maxLength)
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove script tags and event handlers
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    // Remove control characters
    .replace(/[\x00-\x1F\x7F]/g, '');

  return sanitized;
}

/**
 * Sanitize string array (e.g., for notes, names)
 */
export function sanitizeStringArray(input: (string | null | undefined)[] | null | undefined, maxLength = 500): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => sanitizeString(item, maxLength)).filter((s) => s.length > 0);
}

/**
 * Validate PIN format and complexity
 * PINs should be 4-6 digits (current requirement)
 * Can be extended for stronger requirements
 */
export function validatePin(pin: string | null | undefined, rejectWeak = true): { valid: boolean; error?: string } {
  if (!pin) return { valid: false, error: 'PIN is required' };
  const pinStr = String(pin).trim();

  // Current requirement: 4-6 digits
  if (!/^\d{4,6}$/.test(pinStr)) {
    return { valid: false, error: 'PIN must be 4-6 digits' };
  }

  // Only reject weak PINs when creating/updating (not during login)
  if (rejectWeak) {
    const weakPins = ['0000', '1111', '1234', '12345', '123456', '9999', '99999', '999999'];
    if (weakPins.includes(pinStr)) {
      return { valid: false, error: 'PIN is too common. Please choose a different PIN.' };
    }
  }

  return { valid: true };
}

/**
 * Sanitize numeric input
 */
export function sanitizeNumber(input: any, min?: number, max?: number, defaultValue = 0): number {
  const num = Number(input);
  if (!Number.isFinite(num)) return defaultValue;
  if (min !== undefined && num < min) return min;
  if (max !== undefined && num > max) return max;
  return num;
}

/**
 * Generate secure random token
 */
export function generateSecureToken(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const randomBytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    // Fallback for environments without crypto API
    for (let i = 0; i < length; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(randomBytes)
    .map((byte) => chars[byte % chars.length])
    .join('');
}

/**
 * Hash sensitive data (for logging, not storage)
 */
export function hashSensitive(data: string): string {
  // Simple hash for logging (not cryptographic)
  // For actual password hashing, use bcrypt
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}
