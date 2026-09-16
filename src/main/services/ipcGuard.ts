/**
 * The single door every IPC handler goes through.
 *
 * `ipcHandle` is a drop-in replacement for `ipcMain.handle`. It looks the
 * channel up in `IPC_POLICIES`, enforces the rate limit / session / role rules,
 * and only then runs the handler. Handlers are otherwise untouched, so the
 * access rules for the whole app read as one table instead of being scattered
 * across five thousand lines.
 *
 * Denials throw `forbidden`, which the renderer already treats as a hard
 * failure, and are written to the security log so they show up in
 * `admin:getSecurityLog`.
 */

import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { checkRateLimit, logSecurityEvent } from './security';
import { policyFor } from './ipcPolicy';
import type { IpcPolicy } from './ipcPolicy';
import { getSession, senderHoldsToken, windowKindFor } from './ipcSession';
import type { IpcSession } from './ipcSession';

export class IpcAuthorizationError extends Error {
  readonly code: string;

  constructor(code: 'forbidden' | 'rate_limited' | 'unauthenticated') {
    // The message stays generic on purpose: a renderer that is probing
    // channels should not learn whether it failed on session or on role.
    super(code === 'rate_limited' ? 'rate_limited' : 'forbidden');
    this.name = 'IpcAuthorizationError';
    this.code = code;
  }
}

export interface IpcCallContext {
  /** Null when the channel is public or granted purely by window kind. */
  session: IpcSession | null;
  senderId: number;
  windowKind: ReturnType<typeof windowKindFor>;
}

type GuardedListener<T> = (
  event: IpcMainInvokeEvent,
  payload: any,
  ctx: IpcCallContext,
) => T | Promise<T>;

/**
 * The whole access decision, as a pure function so it can be tested without
 * standing up Electron.
 */
export function decideAccess(
  policy: IpcPolicy,
  ctx: IpcCallContext,
): { ok: true } | { ok: false; error: IpcAuthorizationError } {
  if (policy.allow === 'public') return { ok: true };

  // A shell that runs without a login (the kitchen display) is granted by
  // window identity. `webContents.id` is assigned by Electron and cannot be
  // spoofed from renderer code, so this is a real check rather than a hint.
  if (policy.windows?.includes(ctx.windowKind)) return { ok: true };

  if (!ctx.session) {
    return { ok: false, error: new IpcAuthorizationError('unauthenticated') };
  }

  if (policy.allow === 'session') return { ok: true };

  if (policy.allow.includes(ctx.session.role)) return { ok: true };

  return { ok: false, error: new IpcAuthorizationError('forbidden') };
}

/**
 * A till that is already bound to this token is re-presenting it (boot, HMR,
 * Strict Mode), not guessing. Counting those against the resume limiter is
 * what locked the floor after a burst of Vite remounts.
 */
export function skipResumeRateLimit(
  channel: string,
  payload: unknown,
  senderId: number,
): boolean {
  if (channel !== 'auth:resumeSession') return false;
  const token =
    payload &&
    typeof payload === 'object' &&
    'token' in payload &&
    typeof (payload as { token?: unknown }).token === 'string'
      ? (payload as { token: string }).token
      : '';
  return senderHoldsToken(senderId, token);
}

/**
 * Register an IPC handler behind its policy.
 *
 * Throws at startup if the channel has no policy — that is deliberate. A
 * channel with no declared access rule is a channel nobody decided about, and
 * failing loudly at boot in development is far better than shipping it open.
 */
export function ipcHandle<T>(channel: string, listener: GuardedListener<T>) {
  const policy = policyFor(channel);
  if (!policy) {
    throw new Error(
      `IPC channel "${channel}" has no entry in IPC_POLICIES. ` +
        'Add one in src/main/services/ipcPolicy.ts before registering it.',
    );
  }
  ipcMain.handle(channel, async (event, payload) => {
    const senderId = Number(event?.sender?.id || 0);
    const windowKind = windowKindFor(senderId);

    if (
      policy.rateLimit &&
      !skipResumeRateLimit(channel, payload, senderId) &&
      !checkRateLimit(event, channel, policy.rateLimit)
    ) {
      throw new IpcAuthorizationError('rate_limited');
    }

    const ctx: IpcCallContext = {
      session: getSession(senderId),
      senderId,
      windowKind,
    };

    const verdict = decideAccess(policy, ctx);
    if (!verdict.ok) {
      logSecurityEvent('ipc_denied', {
        channel,
        senderId,
        windowKind,
        reason: verdict.error.code,
        role: ctx.session?.role ?? null,
        userId: ctx.session?.userId ?? null,
      });
      if (verdict.error.code === 'unauthenticated') {
        try {
          event.sender.send('auth:forceLogout', { reason: 'unauthorized' });
        } catch {
          // ignore
        }
      }
      throw verdict.error;
    }

    const t0 = Date.now();
    try {
      return await listener(event, payload, ctx);
    } finally {
      const ms = Date.now() - t0;
      if (ms >= 50) console.log(`[boot] ipc ${channel} ${ms}ms`);
    }
  });
}
