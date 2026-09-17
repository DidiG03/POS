import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import { useAdminSessionStore } from '../../stores/adminSession';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';
import { hydrateLicenseEditionFromSettings } from '../../utils/hydrateLicenseEdition';
import { useOrderContext } from '@shared/stores/orderContext';
import {
  ensureStoreCounterSelected,
  staffPosHomePath,
} from '@shared/editionCapabilities';
import { isClockOnlyRole } from '@shared/utils/roles';
import { isClockCaptureEnabled } from '@shared/clockCapture';
import { clockCaptureFromChange } from '@shared/settingsChange';
import { BrandMark } from '../../components/BrandMark';
import { resolveBackendHost } from '../../utils/backendHost';
import { DocumentMeta } from '../../components/DocumentMeta';
import { DevEditionSwitch } from '../components/DevEditionSwitch';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  SectionLabel,
  StatusDot,
  cn,
} from '../../components/ui';
import {
  IconArrowLeft,
  IconChevronRight,
  IconUsers,
} from '../../components/icons';
import { toast } from '../../stores/toasts';
import {
  classifyLanLoginError,
  lanLoginUserMessage,
} from '../../utils/lanLoginError';
import { captureRendererException } from '../../utils/sentryBrowser';
import { applyHostPosUiTheme } from '../../theme';
import { POS_CACHE, peekSettings } from '../../utils/posReadCache';
import { invalidateCache } from '../../utils/swrCache';
import { loginDirectoryState } from '../../utils/loginDirectory';
import { bootTrace } from '@shared/bootTrace';
import { retryLazyImport } from '../../utils/lazyRetry';
import { loadPosRealtimeSync } from '../../utils/loadPosRealtimeSync';

function staffInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] || '';
  const second = parts[1]?.[0] || '';
  return (first + second).toUpperCase() || '?';
}

function StaffTile({
  name,
  selected,
  onShift,
  onClick,
}: {
  name: string;
  selected: boolean;
  onShift?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn('pos-staff-tile', selected && 'pos-staff-tile--active')}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="pos-avatar">{staffInitials(name)}</span>
        <span className="truncate text-[13px] font-medium text-gray-100">
          {name}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {onShift ? <StatusDot tone="accent" /> : null}
        <IconChevronRight className="size-4 shrink-0 text-gray-500" />
      </span>
    </button>
  );
}

/** Holds the shape of an empty staff column without inventing copy for it —
 * the column heading above already says what belongs here. */
function ColumnPlaceholder() {
  return (
    <div className="h-[52px] rounded-[0.7rem] border border-dashed border-[var(--pos-border)]" />
  );
}

export default function LoginPage() {
  const { t, i18n } = useTranslation();
  const PAIRING_STORAGE_KEY = 'pos_pairing_code';
  const pairingCodeRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pairingCode, setPairingCode] = useState<string>(() => {
    try {
      return localStorage.getItem(PAIRING_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isBrowserClient =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const isAdminApp =
    typeof window !== 'undefined' && Boolean((window as any).__ADMIN_APP__);
  // Pairing is issued by Admin for tablets / KDS. The Admin app talking HTTP
  // to the till is still a "browser client", but it must not ask for its own
  // invite code.
  const needsPairingCode = isBrowserClient && !isAdminApp;
  // Admin login exists only in the OneTap Admin companion, never on POS.
  const adminPath = (location?.pathname || '').replace(/\/+$/, '') || '/';
  const isAdminContext =
    isAdminApp && (adminPath === '/admin' || adminPath.startsWith('/admin/'));
  const isKdsContext =
    (location?.pathname || '').startsWith('/kds') ||
    (typeof window !== 'undefined' &&
      (window.location.hash || '').startsWith('#/kds'));
  const hasHydrated = useSessionStore((s) => s.hasHydrated);
  const hasReservations = useLicenseCapabilities((s) => s.hasReservations);
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const reservationsReady = useLicenseCapabilities((s) => s.hydrated);
  const setSelectedTable = useOrderContext((s) => s.setSelectedTable);

  const goStaffHome = (staff: { id?: number; role?: string }, kds: boolean) => {
    const clockOnly = isClockOnlyRole((staff as any).role);
    ensureStoreCounterSelected({
      hasTables,
      userId: staff?.id,
      selectedTable: useOrderContext.getState().selectedTable,
      setSelectedTable,
    });
    navigate(staffPosHomePath({ hasTables, clockOnly, kds }));
  };

  const showLoginMessage = (message: string) => {
    toast.error(message, { timeoutMs: 5_000 });
  };

  const clearStoredPairing = () => {
    try {
      localStorage.removeItem(PAIRING_STORAGE_KEY);
    } catch {
      // ignore
    }
    setPairingCode('');
    if (pairingCodeRef.current) pairingCodeRef.current.value = '';
  };

  const onSubmit = async () => {
    if (!hasHydrated) {
      showLoginMessage(t('login.loginFailed'));
      return;
    }
    if (pin.length < 4) {
      showLoginMessage(t('login.pinTooShort'));
      return;
    }
    // Drop focus from the PIN/pairing input BEFORE we kick off the async
    // login flow. Without this, the iOS soft keyboard stays up while the
    // network call resolves and the navigation happens; when the keyboard
    // finally collapses on the next page it triggers a separate viewport
    // reflow that looks like the screen is jittering.
    try {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && typeof ae.blur === 'function') ae.blur();
    } catch {
      // ignore
    }
    setSubmitting(true);
    try {
      const codeFromInput =
        pairingCodeRef.current?.value
          ?.trim()
          .replace(/[^0-9A-Za-z]/g, '')
          .slice(0, 12) || '';
      const effectivePairingCode = needsPairingCode
        ? codeFromInput || pairingCode || undefined
        : undefined;
      // Tablet always sends to host
      const user = await window.api.auth.loginWithPin(
        pin,
        selectedId ?? undefined,
        effectivePairingCode,
      );
      // Pairing succeeded — persist the code so the user doesn't need to re-enter it
      if (needsPairingCode && effectivePairingCode) {
        try {
          localStorage.setItem(PAIRING_STORAGE_KEY, effectivePairingCode);
          setPairingCode(effectivePairingCode);
          if (pairingCodeRef.current)
            pairingCodeRef.current.value = effectivePairingCode;
        } catch {
          // ignore
        }
      }
      if (user) {
        if (isAdminContext && user.role !== 'ADMIN') {
          showLoginMessage(t('login.adminOnly'));
          return;
        }
        // Defense-in-depth: even if a stale staff list ever included a Host,
        // they must not be authorised through the POS login. Hosts use the
        // Reservations window exclusively.
        if (
          !isAdminContext &&
          String((user as any).role || '').toUpperCase() === 'HOST'
        ) {
          showLoginMessage(t('login.hostsReservations'));
          return;
        }
        // Admins never enter the POS shell. Back office is OneTap Admin only.
        if (user.role === 'ADMIN' && !isAdminApp) {
          showLoginMessage(t('login.useAdminApp'));
          return;
        }
        if (user.role === 'ADMIN' && isAdminApp) {
          setAdminUser(user);
          navigate('/admin');
          return;
        }
        // Use clock flags and open-shift ids already loaded with the staff
        // list. A second settings/getOpen round-trip is what made PIN login
        // stall on slow Wi-Fi after the host had already accepted the PIN.
        if (!isKdsContext) {
          const clockOn = captureClock === true;
          if (clockOn) {
            let alreadyOpen =
              selectedId != null && openIds.includes(selectedId);
            if (!alreadyOpen && !openShiftKnown && selectedId != null) {
              const open = await window.api.shifts
                .getOpen(user.id)
                .catch(() => null);
              alreadyOpen = Boolean(open);
            }
            if (!alreadyOpen) {
              setShowShiftConfirm(true);
              setPendingUser(user);
              return;
            }
          }
        }
        setUser(user);
        goStaffHome(user, isKdsContext);
      } else {
        showLoginMessage(t('login.invalidPin'));
      }
    } catch (e: unknown) {
      console.error(e);
      const kind = classifyLanLoginError(e);
      if (kind === 'pairing') clearStoredPairing();
      showLoginMessage(lanLoginUserMessage(e, t));
      if (kind === 'host' || kind === 'other') {
        captureRendererException(e, { source: 'login' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const [staff, setStaff] = useState<{ id: number; displayName: string }[]>([]);
  const [openIds, setOpenIds] = useState<number[]>([]);
  const [openShiftKnown, setOpenShiftKnown] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showShiftConfirm, setShowShiftConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingUser, setPendingUser] = useState<any>(null);
  const [captureClock, setCaptureClock] = useState<boolean | null>(null);
  // The app-level BootScreen (main.tsx) already verifies the backend is alive
  // before the router renders, so we never show a second full-page spinner.
  // We track staffLoading to show a subtle inline indicator in the staff grid.
  const [staffLoading, setStaffLoading] = useState(true);
  const { setUser } = useSessionStore();
  const { setUser: setAdminUser } = useAdminSessionStore();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [firstAdminName, setFirstAdminName] = useState('');
  const [firstAdminPin, setFirstAdminPin] = useState('');
  const [creatingFirstAdmin, setCreatingFirstAdmin] = useState(false);
  const [needsFirstAdmin, setNeedsFirstAdmin] = useState(false);
  const [emptyDatabase, setEmptyDatabase] = useState(false);

  useEffect(() => {
    if (selectedId == null) return;
    void retryLazyImport(() => import('../AppLayout'));
    void retryLazyImport(() => import('./TablesPage'));
    void loadPosRealtimeSync();
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOpenShiftKnown(false);
      setNeedsFirstAdmin(false);
      setEmptyDatabase(false);
      const applyChrome = (s: any) => {
        if (!s) return;
        setDevEditionSwitch(Boolean(s.devEditionSwitch));
        applyHostPosUiTheme(s?.preferences?.theme);
        hydrateLicenseEditionFromSettings(s);
      };
      const applySettings = (s: any) => {
        applyChrome(s);
        if (!s) return;
        setCaptureClock(isClockCaptureEnabled(s));
      };

      const cached = peekSettings<any>();
      invalidateCache(POS_CACHE.settings);
      invalidateCache(POS_CACHE.users);
      // Cached chrome (edition, theme) can paint immediately. Clock columns
      // must wait for a live host read — a stale tablet cache defaults the
      // shift feature ON and ignores Admin turning it off.
      if (cached) applyChrome(cached);
      setNotice(null);

      const settingsP = window.api.settings
        .get()
        .then((live) => ({ live: true as const, s: live }))
        .catch(() => ({ live: false as const, s: cached ?? null }));
      const usersP = window.api.auth.listUsers({ includeAdmins: true });

      const got = await settingsP;
      if (cancelled) return;
      const s = got.s;
      if (got.live && s) applySettings(s);
      else if (s) applyChrome(s);

      let users: any[] = [];
      try {
        users = await usersP;
      } catch (e: any) {
        const message = lanLoginUserMessage(e, t);
        setNotice(message);
        toast.error(message, { timeoutMs: 5_000 });
        captureRendererException(e, { source: 'login.listUsers' });
        setStaff([]);
        setOpenIds([]);
        setOpenShiftKnown(true);
        if (!cancelled) setStaffLoading(false);
        return;
      }
      const directory = loginDirectoryState(users, isAdminContext);
      if (directory.needsFirstAdmin) {
        setNotice(null);
        setNeedsFirstAdmin(true);
        setEmptyDatabase(true);
        setStaff([]);
        setOpenIds([]);
        setOpenShiftKnown(true);
        if (!cancelled) setStaffLoading(false);
        return;
      }
      if (cancelled) return;
      setNeedsFirstAdmin(false);
      setEmptyDatabase(directory.emptyDatabase);
      setStaff(directory.staff);
      setStaffLoading(false);
      bootTrace('login:staff');
      if (!isAdminContext && got.live && isClockCaptureEnabled(s)) {
        try {
          const ids = await window.api.shifts.listOpen();
          if (cancelled) return;
          setOpenIds(Array.isArray(ids) ? ids : []);
        } catch (e) {
          void e;
          if (cancelled) return;
          setOpenIds([]);
        }
        setOpenShiftKnown(true);
      } else {
        setOpenIds([]);
        setOpenShiftKnown(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce, isAdminContext, i18n.language, t]);

  useEffect(() => {
    let cancelled = false;
    const refreshStaff = async () => {
      invalidateCache(POS_CACHE.users);
      try {
        const users = await window.api.auth.listUsers({ includeAdmins: true });
        if (cancelled) return;
        const directory = loginDirectoryState(users, isAdminContext);
        if (directory.needsFirstAdmin) {
          setNeedsFirstAdmin(true);
          setEmptyDatabase(true);
          setStaff([]);
          return;
        }
        setNeedsFirstAdmin(false);
        setEmptyDatabase(directory.emptyDatabase);
        setStaff(directory.staff);
      } catch {
        // Keep the Select Staff screen; the live event will retry.
      }
    };
    const onUsers = () => {
      void refreshStaff();
    };
    window.addEventListener('pos:usersChanged', onUsers);
    window.addEventListener('pos:syncCatchup', onUsers);
    const isBrowser =
      typeof window !== 'undefined' &&
      Boolean((window as any).__BROWSER_CLIENT__);
    const pollId = isBrowser
      ? window.setInterval(() => {
          void refreshStaff();
        }, 5_000)
      : null;
    return () => {
      cancelled = true;
      window.removeEventListener('pos:usersChanged', onUsers);
      window.removeEventListener('pos:syncCatchup', onUsers);
      if (pollId != null) window.clearInterval(pollId);
    };
  }, [isAdminContext]);

  useEffect(() => {
    const onSettings = (ev: Event) => {
      const clock = clockCaptureFromChange((ev as CustomEvent).detail);
      if (clock != null) setCaptureClock(clock);
    };
    window.addEventListener('pos:settingsChanged', onSettings);
    return () => window.removeEventListener('pos:settingsChanged', onSettings);
  }, []);

  useEffect(() => {
    if (!showPin) return;
    const el = pinRef.current;
    const focusId = window.requestAnimationFrame(() => {
      try {
        el?.focus({ preventScroll: true });
      } catch {
        el?.focus();
      }
    });
    const lockScroll = () => {
      try {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      } catch {
        // ignore
      }
    };
    window.addEventListener('scroll', lockScroll, { passive: true });
    window.visualViewport?.addEventListener('scroll', lockScroll);
    return () => {
      window.cancelAnimationFrame(focusId);
      window.removeEventListener('scroll', lockScroll);
      window.visualViewport?.removeEventListener('scroll', lockScroll);
    };
  }, [showPin]);

  const [devEditionSwitch, setDevEditionSwitch] = useState(false);
  const adminHostLabel = isAdminApp
    ? (() => {
        const b = resolveBackendHost();
        return b.host ? `${b.host}:${b.httpPort}` : '';
      })()
    : '';

  const onShift = staff.filter((s) => openIds.includes(s.id));
  const offShift = staff.filter((s) => !openIds.includes(s.id));

  return (
    <div
      // Pad the page by the iOS safe-area insets so the staff selection
      // card and the PIN modal don't sit under the notch / home indicator,
      // but keep `bg-gray-900` so the WebView still paints those zones
      // (no black bars). `max(...)` keeps the original p-3/sm:p-6 spacing
      // on devices without a safe area.
      className={cn(
        'h-dvh flex flex-col items-center pos-app pos-app--auth px-3 sm:px-6',
        showPin
          ? 'pos-app--auth-pin'
          : 'justify-center overflow-y-auto pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-[max(1.5rem,env(safe-area-inset-top))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]',
      )}
    >
      <DocumentMeta
        title={
          isAdminContext ? t('adminLayout.panelTitle') : t('login.selectStaff')
        }
      />
      <div className={cn('shrink-0 space-y-3', showPin ? 'mb-4' : 'mb-6')}>
        <BrandMark size="lg" subtitle={t('brand.tagline')} />
        {adminHostLabel ? (
          <div className="text-center text-[12px] text-gray-400">
            {adminHostLabel}
          </div>
        ) : null}
        <DevEditionSwitch allowed={devEditionSwitch} />
      </div>
      <div
        className={cn(
          'pos-surface-panel flex w-full flex-col overflow-hidden',
          'max-h-[calc(100dvh-7rem)] sm:max-h-[calc(100dvh-9rem)]',
          // The PIN step only needs one column, so the card narrows for it.
          showPin ? 'max-w-[380px]' : 'max-w-2xl',
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/7 px-4 py-3">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* Back arrow shows only on the PIN screen so the user can
                return to staff selection without it feeling like a modal
                cancel. We reuse `setShowPin(false)` so all the existing
                "leave PIN" cleanup paths stay consistent. */}
            {showPin && (
              <button
                type="button"
                aria-label={t('login.backToStaff')}
                title={t('common.back')}
                onClick={() => {
                  setShowPin(false);
                  setPin('');
                }}
                className="pos-ticket-iconbtn -ml-1 shrink-0"
              >
                <IconArrowLeft />
              </button>
            )}
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-gray-50">
              {showPin
                ? selectedId
                  ? t('login.enterPinFor', {
                      name:
                        staff.find((s) => s.id === selectedId)?.displayName ??
                        '',
                    })
                  : t('login.enterPin')
                : isAdminContext
                  ? t('login.adminLogin')
                  : t('login.selectStaff')}
            </h1>
          </div>
          {!showPin && !isAdminContext && (
            <div className="flex shrink-0 items-center gap-2">
              {reservationsReady && hasReservations ? (
                <Button
                  size="sm"
                  onClick={async () => {
                    // On Electron, openWindow() spawns the dedicated reservation
                    // window. On the mobile / browser shell it returns false, in
                    // which case we route to /reservations in the same SPA.
                    let opened = false;
                    try {
                      opened = Boolean(
                        await window.api.reservations.openWindow(),
                      );
                    } catch {
                      opened = false;
                    }
                    if (!opened) navigate('/reservations');
                  }}
                  title={t('login.reservationsTitle')}
                >
                  {t('login.reservations')}
                </Button>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          {notice && (
            <div className="pos-alert shrink-0 !border-amber-500/30 !bg-amber-500/10 p-3 text-[13px] text-amber-200">
              {notice}
            </div>
          )}
          {!showPin && !staffLoading && needsFirstAdmin && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <Input
                placeholder={t('login.firstAdminNamePlaceholder')}
                value={firstAdminName}
                onChange={(e) => setFirstAdminName(e.target.value)}
                autoComplete="off"
              />
              <Input
                type="password"
                placeholder={t('login.firstAdminPinPlaceholder')}
                value={firstAdminPin}
                onChange={(e) =>
                  setFirstAdminPin(
                    e.target.value.replace(/\D/g, '').slice(0, 8),
                  )
                }
                inputMode="numeric"
                autoComplete="new-password"
              />
              <Button
                variant="primary"
                block
                loading={creatingFirstAdmin}
                disabled={
                  firstAdminName.trim().length < 2 || firstAdminPin.length < 4
                }
                onClick={async () => {
                  setCreatingFirstAdmin(true);
                  try {
                    await window.api.auth.createUser({
                      displayName: firstAdminName.trim(),
                      role: 'ADMIN',
                      pin: firstAdminPin,
                      active: true,
                    } as any);
                    setNotice(null);
                    setFirstAdminName('');
                    setFirstAdminPin('');
                    setReloadNonce((n) => n + 1);
                  } catch (e: any) {
                    showLoginMessage(
                      e?.message || t('login.firstAdminCreateFailed'),
                    );
                  } finally {
                    setCreatingFirstAdmin(false);
                  }
                }}
              >
                {creatingFirstAdmin
                  ? t('login.firstAdminCreating')
                  : t('login.firstAdminCreate')}
              </Button>
            </div>
          )}

          {!showPin && isAdminContext && !needsFirstAdmin ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <SectionLabel className="mb-2 shrink-0">
                {t('login.admins')}
              </SectionLabel>
              <div className="min-h-0 flex-1 space-y-1.5 overflow-auto">
                {staff.map((s) => (
                  <StaffTile
                    key={s.id}
                    name={s.displayName}
                    selected={selectedId === s.id}
                    onClick={() => {
                      setSelectedId(s.id);
                      setPin('');
                      setShowPin(true);
                    }}
                  />
                ))}
                {staff.length === 0 && (
                  <EmptyState
                    compact
                    icon={<IconUsers />}
                    title={
                      staffLoading
                        ? t('login.loadingStaff')
                        : t('login.noAdminUsersShort')
                    }
                  />
                )}
              </div>
            </div>
          ) : !showPin && !isAdminContext && captureClock !== true ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-1.5 overflow-auto">
                {staff.map((s) => (
                  <StaffTile
                    key={s.id}
                    name={s.displayName}
                    selected={selectedId === s.id}
                    onClick={() => {
                      setSelectedId(s.id);
                      setPin('');
                      setShowPin(true);
                    }}
                  />
                ))}
                {staff.length === 0 && (
                  <EmptyState
                    compact
                    icon={<IconUsers />}
                    title={
                      staffLoading
                        ? t('login.loadingStaff')
                        : emptyDatabase
                          ? t('login.waitingForAdminSetup')
                          : t('login.noStaffSync')
                    }
                    description={
                      staffLoading
                        ? undefined
                        : emptyDatabase
                          ? t('login.waitingForAdminSetupHelp')
                          : t('login.useAdminApp')
                    }
                  />
                )}
              </div>
            </div>
          ) : !showPin && !isAdminContext ? (
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex min-h-0 flex-col">
                <SectionLabel className="mb-2 shrink-0">
                  {t('login.notClockedIn')}
                </SectionLabel>
                <div className="min-h-0 flex-1 space-y-1.5 overflow-auto">
                  {staff.length === 0 && !staffLoading ? (
                    <EmptyState
                      compact
                      icon={<IconUsers />}
                      title={
                        emptyDatabase
                          ? t('login.waitingForAdminSetup')
                          : t('login.noStaffSync')
                      }
                      description={
                        emptyDatabase
                          ? t('login.waitingForAdminSetupHelp')
                          : t('login.useAdminApp')
                      }
                    />
                  ) : offShift.length === 0 ? (
                    <ColumnPlaceholder />
                  ) : null}
                  {offShift.map((s) => (
                    <StaffTile
                      key={s.id}
                      name={s.displayName}
                      selected={selectedId === s.id}
                      onClick={() => {
                        setSelectedId(s.id);
                        setPin('');
                        setShowPin(true);
                      }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex min-h-0 flex-col">
                <SectionLabel className="mb-2 shrink-0">
                  {t('login.clockedIn')}
                </SectionLabel>
                <div className="min-h-0 flex-1 space-y-1.5 overflow-auto">
                  {onShift.length === 0 && !staffLoading ? (
                    <ColumnPlaceholder />
                  ) : null}
                  {onShift.map((s) => (
                    <StaffTile
                      key={s.id}
                      name={s.displayName}
                      selected={selectedId === s.id}
                      onShift
                      onClick={() => {
                        setSelectedId(s.id);
                        setPin('');
                        setShowPin(true);
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {showPin && (
            // Inline PIN screen — replaces the staff list inside the same
            // card so it visually feels like a page transition, not a modal.
            // The card frame and header stay so the user keeps the
            // "I'm on the login page" context.
            <div className="flex flex-col gap-3">
              {/* Mask PIN (dots/bullets). `inputMode="numeric"` + `pattern` keep a
                  digits-friendly keyboard on mobile. 20px font avoids Safari zoom. */}
              <input
                ref={pinRef}
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={t('login.pinPlaceholder')}
                maxLength={6}
                autoComplete="one-time-code"
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D+/g, '').slice(0, 6))
                }
                className="pos-input py-3 text-center tracking-[0.55em] tabular"
                style={{ fontSize: '20px' }}
                onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
              />
              {needsPairingCode ? (
                <input
                  ref={pairingCodeRef}
                  type="text"
                  inputMode="numeric"
                  placeholder={t('login.pairingPlaceholder')}
                  maxLength={12}
                  defaultValue={pairingCode}
                  className="pos-input text-center tabular"
                  onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                />
              ) : null}
              <Button
                variant="primary"
                size="lg"
                block
                loading={submitting}
                disabled={!hasHydrated}
                onClick={onSubmit}
              >
                {t('login.loginSubmit')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {!isAdminContext && pendingUser && (
        <ConfirmDialog
          open={showShiftConfirm}
          title={t('login.startShiftTitle', { name: pendingUser.displayName })}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          onCancel={() => {
            setShowShiftConfirm(false);
            setPendingUser(null);
          }}
          onConfirm={async () => {
            try {
              const ae = document.activeElement as HTMLElement | null;
              if (ae && typeof ae.blur === 'function') ae.blur();
            } catch {
              // ignore
            }
            try {
              await window.api.shifts.clockIn(pendingUser.id);
              setShowShiftConfirm(false);
              setPendingUser(null);
              setUser(pendingUser);
              goStaffHome(pendingUser, isKdsContext);
            } catch (e: any) {
              setShowShiftConfirm(false);
              const msg = String(e?.message || e || '').trim();
              showLoginMessage(msg || t('login.loginFailed'));
            }
          }}
        />
      )}
    </div>
  );
}
