import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import { useAdminSessionStore } from '../../stores/adminSession';
import { isClockOnlyRole } from '@shared/utils/roles';
import { BrandMark } from '../../components/BrandMark';
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
    <div className="h-[52px] rounded-lg border border-dashed border-white/8" />
  );
}

export default function LoginPage() {
  const { t, i18n } = useTranslation();
  const PAIRING_STORAGE_KEY = 'pos_pairing_code';
  const pairingCodeRef = useRef<HTMLInputElement>(null);
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pairingCode, setPairingCode] = useState<string>(() => {
    try {
      return localStorage.getItem(PAIRING_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isBrowserClient =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  // Admin window/routing can be hash-based (#/admin) or path-based (/admin). Detect both.
  const isAdminContext =
    (location?.pathname || '').startsWith('/admin') ||
    (typeof window !== 'undefined' &&
      (window.location.hash || '').startsWith('#/admin'));
  const isKdsContext =
    (location?.pathname || '').startsWith('/kds') ||
    (typeof window !== 'undefined' &&
      (window.location.hash || '').startsWith('#/kds'));
  const hasHydrated = useSessionStore((s) => s.hasHydrated);

  const onSubmit = async () => {
    setError(null);
    if (!hasHydrated) return;
    if (pin.length < 4) {
      setError(t('login.pinTooShort'));
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
    try {
      const codeFromInput =
        pairingCodeRef.current?.value
          ?.trim()
          .replace(/[^0-9A-Za-z]/g, '')
          .slice(0, 12) || '';
      const effectivePairingCode = isBrowserClient
        ? codeFromInput || pairingCode || undefined
        : undefined;
      // Tablet always sends to host
      const user = await window.api.auth.loginWithPin(
        pin,
        selectedId ?? undefined,
        effectivePairingCode,
      );
      // Pairing succeeded — persist the code so the user doesn't need to re-enter it
      if (isBrowserClient && effectivePairingCode) {
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
        const clockOnly = isClockOnlyRole((user as any).role);
        if (isAdminContext && user.role !== 'ADMIN') {
          setError(t('login.adminOnly'));
          return;
        }
        // Defense-in-depth: even if a stale staff list ever included a Host,
        // they must not be authorised through the POS login. Hosts use the
        // Reservations window exclusively.
        if (
          !isAdminContext &&
          String((user as any).role || '').toUpperCase() === 'HOST'
        ) {
          setError(t('login.hostsReservations'));
          return;
        }
        // Block admin panel on browser/tablet — admin must use the desktop app
        if (isBrowserClient && isAdminContext) {
          setError(t('login.adminNoTablet'));
          return;
        }
        // Admin goes straight to admin shell (Electron only)
        if (user.role === 'ADMIN' && !isBrowserClient) {
          if (isAdminContext) setAdminUser(user);
          else setUser(user);
          navigate('/admin');
          return;
        }
        // Staff requires open shift (but KDS clients should be usable without shift clock-in)
        if (!isKdsContext) {
          const open = await window.api.shifts.getOpen(user.id);
          if (!open) {
            setShowShiftConfirm(true);
            setPendingUser(user);
            return;
          }
        }
        setUser(user);
        navigate(
          isKdsContext ? '/kds' : clockOnly ? '/app/clock' : '/app/tables',
        );
      } else setError(t('login.invalidPin'));
    } catch (e: any) {
      console.error(e);
      const msg = String(e?.message || e || '');
      if (msg.toLowerCase().includes('pairing code')) {
        // Stored code is no longer valid — clear it so the input appears
        try {
          localStorage.removeItem(PAIRING_STORAGE_KEY);
        } catch {
          // ignore
        }
        setPairingCode('');
        if (pairingCodeRef.current) pairingCodeRef.current.value = '';
        setError(t('login.pairingRequired'));
        return;
      }
      setError(t('login.loginFailed'));
    }
  };

  const [staff, setStaff] = useState<{ id: number; displayName: string }[]>([]);
  const [openIds, setOpenIds] = useState<number[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showShiftConfirm, setShowShiftConfirm] = useState(false);
  const [pendingUser, setPendingUser] = useState<any>(null);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await window.api.settings.get();
      setEnableAdmin(s.enableAdmin ?? false);
      setNotice(null);

      let users: any[] = [];
      try {
        users = await window.api.auth.listUsers({
          includeAdmins: isAdminContext,
        });
      } catch (e: any) {
        setNotice(e?.message || t('login.loadUsersFailed'));
        setStaff([]);
        setOpenIds([]);
        if (!cancelled) setStaffLoading(false);
        return;
      }
      if (Array.isArray(users) && users.length === 0) {
        setNotice(
          isAdminContext
            ? t('login.noAdminUsersLocal')
            : t('login.noStaffUsers'),
        );
        setStaff([]);
        setOpenIds([]);
        if (!cancelled) setStaffLoading(false);
        return;
      }
      const list = isAdminContext
        ? users.filter((u) => u.role === 'ADMIN' && u.active)
        : // Hosts only ever sign in through the Reservations window; never
          // expose them on the waiter/cashier POS login screen.
          users.filter(
            (u) =>
              u.active &&
              u.role !== 'ADMIN' &&
              String(u.role || '').toUpperCase() !== 'HOST',
          );
      if (cancelled) return;
      setStaff(list);
      setStaffLoading(false);
      if (!isAdminContext) {
        try {
          const ids = await window.api.shifts.listOpen();
          if (cancelled) return;
          setOpenIds(ids);
        } catch (e) {
          void e;
          if (cancelled) return;
          setOpenIds([]);
        }
      } else {
        setOpenIds([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce, isAdminContext, i18n.language, t]);

  const [enableAdmin, setEnableAdmin] = useState(false);

  const onShift = staff.filter((s) => openIds.includes(s.id));
  const offShift = staff.filter((s) => !openIds.includes(s.id));

  return (
    <div
      // Pad the page by the iOS safe-area insets so the staff selection
      // card and the PIN modal don't sit under the notch / home indicator,
      // but keep `bg-gray-900` so the WebView still paints those zones
      // (no black bars). `max(...)` keeps the original p-3/sm:p-6 spacing
      // on devices without a safe area.
      className="min-h-dvh flex flex-col items-center justify-center pos-app pos-app--auth overflow-hidden px-3 sm:px-6 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-[max(1.5rem,env(safe-area-inset-top))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
    >
      <div className="mb-6 shrink-0">
        <BrandMark size="lg" subtitle={t('brand.tagline')} />
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
                  setError(null);
                }}
                className="pos-icon-btn -ml-2 shrink-0"
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
              {!isBrowserClient && enableAdmin && (
                <Button size="sm" onClick={() => window.api.admin.openWindow()}>
                  {t('common.admin')}
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          {notice && (
            <div className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[13px] text-amber-200">
              {notice}
            </div>
          )}
          {isAdminContext &&
            !showPin &&
            !staffLoading &&
            staff.length === 0 && (
              <div className="shrink-0 rounded-lg border border-white/7 bg-gray-900 p-3.5">
                <div className="text-[13px] font-semibold text-gray-100">
                  {t('login.firstAdminTitle')}
                </div>
                <div className="mt-0.5 text-[12px] text-gray-400">
                  {t('login.firstAdminHelp')}
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Input
                    className="flex-1"
                    placeholder={t('login.firstAdminNamePlaceholder')}
                    value={firstAdminName}
                    onChange={(e) => setFirstAdminName(e.target.value)}
                    autoComplete="off"
                  />
                  <Input
                    className="sm:w-36"
                    placeholder={t('login.firstAdminPinPlaceholder')}
                    value={firstAdminPin}
                    onChange={(e) =>
                      setFirstAdminPin(
                        e.target.value.replace(/\D/g, '').slice(0, 8),
                      )
                    }
                    inputMode="numeric"
                    autoComplete="off"
                  />
                  <Button
                    variant="primary"
                    loading={creatingFirstAdmin}
                    disabled={
                      firstAdminName.trim().length < 2 ||
                      firstAdminPin.length < 4
                    }
                    onClick={async () => {
                      setError(null);
                      setCreatingFirstAdmin(true);
                      try {
                        await window.api.auth.createUser({
                          displayName: firstAdminName.trim(),
                          role: 'ADMIN',
                          pin: firstAdminPin,
                          active: true,
                        } as any);
                        setNotice(t('login.firstAdminCreated'));
                        setFirstAdminName('');
                        setFirstAdminPin('');
                        setReloadNonce((n) => n + 1);
                      } catch (e: any) {
                        setError(
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
              </div>
            )}

          {!showPin && isAdminContext ? (
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
                      setError(null);
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
                      title={t('login.noStaffSync')}
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
                        setError(null);
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
                        setError(null);
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
                autoFocus
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
              {isBrowserClient && (
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
              )}
              {error && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-[13px] text-rose-200">
                  {error}
                </div>
              )}
              <Button
                variant="primary"
                size="lg"
                block
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
              navigate(
                isKdsContext
                  ? '/kds'
                  : isClockOnlyRole((pendingUser as any).role)
                    ? '/app/clock'
                    : '/app/tables',
              );
            } catch (e: any) {
              setShowShiftConfirm(false);
              const msg = String(e?.message || e || '').trim();
              setError(msg || t('login.loginFailed'));
            }
          }}
        />
      )}
    </div>
  );
}
