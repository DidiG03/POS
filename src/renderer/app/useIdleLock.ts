import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IDLE_LOCK_DEFAULT_MINUTES,
  idleLockMinutes,
  shouldIdleLock,
} from '@shared/idleLock';
import { useSessionStore } from '../stores/session';
import { useAdminSessionStore } from '../stores/adminSession';
import { useReservationSessionStore } from '../stores/reservationSession';
import { sessionShellFromWindow } from '../stores/sessionPersist';

const ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'touchstart',
  'wheel',
] as const;
const CHECK_EVERY_MS = 15_000;

/** Screens nobody signs in to: a kitchen display is watched, not touched. */
function isUnattendedScreen(): boolean {
  const w = window as any;
  if (w.__KDS_APP__) return true;
  return String(window.location.hash || '').startsWith('#/kds');
}

function signedInHere(): boolean {
  const shell = sessionShellFromWindow(window.location.hash || '', {
    adminApp: Boolean((window as any).__ADMIN_APP__),
  });
  if (shell === 'admin') return Boolean(useAdminSessionStore.getState().user);
  if (shell === 'reservations') {
    return Boolean(useReservationSessionStore.getState().user);
  }
  return Boolean(useSessionStore.getState().user);
}

/**
 * Back to the PIN pad after `security.idleLockMinutes` without a touch
 * (`@shared/idleLock`). Uses the app's one sign-out (`pos:forceLogout`),
 * which keeps unsent orders on the device for that person's next sign-in.
 */
export function useIdleLock(): void {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState<number>(IDLE_LOCK_DEFAULT_MINUTES);
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await (window as any).api?.settings?.get?.();
        if (!cancelled && s) setMinutes(idleLockMinutes(s));
      } catch {
        // Keep the current value; the next settings change tries again.
      }
    };
    void load();
    window.addEventListener('pos:settingsChanged', load);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:settingsChanged', load);
    };
  }, []);

  useEffect(() => {
    const touch = () => {
      lastActivity.current = Date.now();
    };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, touch, { passive: true, capture: true });
    }
    // A fresh sign-in starts the clock again.
    const unsubs = [
      useSessionStore.subscribe((s, p) => {
        if (s.user && s.user !== p.user) touch();
      }),
      useAdminSessionStore.subscribe((s, p) => {
        if (s.user && s.user !== p.user) touch();
      }),
      useReservationSessionStore.subscribe((s: any, p: any) => {
        if (s.user && s.user !== p.user) touch();
      }),
    ];
    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, touch, { capture: true });
      }
      for (const u of unsubs) u();
    };
  }, []);

  useEffect(() => {
    if (!(minutes > 0)) return;
    const check = () => {
      if (isUnattendedScreen()) return;
      if (
        !shouldIdleLock({
          minutes,
          lastActivityMs: lastActivity.current,
          nowMs: Date.now(),
          signedIn: signedInHere(),
        })
      ) {
        return;
      }
      lastActivity.current = Date.now();
      try {
        window.dispatchEvent(
          new CustomEvent('pos:forceLogout', {
            detail: { reason: t('boot.lockedIdle', { minutes }) },
          }),
        );
      } catch {
        // ignore
      }
    };
    const id = window.setInterval(check, CHECK_EVERY_MS);
    // A phone put away keeps no timers; check the moment it is looked at.
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [minutes, t]);
}
