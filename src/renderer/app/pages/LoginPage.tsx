import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/session';
import { useAdminSessionStore } from '../../stores/adminSession';
import { isClockOnlyRole } from '@shared/utils/roles';

export default function LoginPage() {
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
  const [adminBusinessCode, setAdminBusinessCode] = useState<string>('');
  const [adminBusinessCodeMode, setAdminBusinessCodeMode] =
    useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isBrowserClient =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const isCloudBrowserClient =
    typeof window !== 'undefined' && Boolean((window as any).__CLOUD_CLIENT__);
  // Admin window/routing can be hash-based (#/admin) or path-based (/admin). Detect both.
  const isAdminContext =
    (location?.pathname || '').startsWith('/admin') ||
    (typeof window !== 'undefined' &&
      (window.location.hash || '').startsWith('#/admin'));
  const isKdsContext =
    (location?.pathname || '').startsWith('/kds') ||
    (typeof window !== 'undefined' &&
      (window.location.hash || '').startsWith('#/kds'));

  const onSubmit = async () => {
    setError(null);
    if (pin.length < 4) {
      setError('Enter 4-6 digits');
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
      // Tablet always sends to host; host proxies to cloud with correct userId when needed
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
          setError('Admin access only');
          return;
        }
        // Defense-in-depth: even if a stale staff list ever included a Host,
        // they must not be authorised through the POS login. Hosts use the
        // Reservations window exclusively.
        if (
          !isAdminContext &&
          String((user as any).role || '').toUpperCase() === 'HOST'
        ) {
          setError('Hosts sign in through the Reservations panel.');
          return;
        }
        // Block admin panel on browser/tablet — admin must use the desktop app
        if (isBrowserClient && isAdminContext) {
          setError('Admin panel is not available on tablets');
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
      } else setError('Invalid PIN');
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
        setError(
          'Pairing code required (ask the manager / Admin → Settings → LAN / Tablets).',
        );
        return;
      }
      setError('Login failed');
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
  const [boot, setBoot] = useState<{
    staffLoaded: boolean;
    openLoaded: boolean;
  }>({ staffLoaded: true, openLoaded: true });
  const [staffLoading, setStaffLoading] = useState(true);
  const { setUser } = useSessionStore();
  const { setUser: setAdminUser } = useAdminSessionStore();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [adminBusinessPassword, setAdminBusinessPassword] = useState('');
  const [usingCode, setUsingCode] = useState(false);

  useEffect(() => {
    const onCloud = () => setReloadNonce((n) => n + 1);
    window.addEventListener('pos:cloudConfigChanged', onCloud as any);
    return () =>
      window.removeEventListener('pos:cloudConfigChanged', onCloud as any);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBoot({ staffLoaded: false, openLoaded: isAdminContext });
    (async () => {
      const s = await window.api.settings.get();
      setEnableAdmin(s.enableAdmin ?? false);
      const backendUrl = String((s as any)?.cloud?.backendUrl || '').trim();
      const businessCode = String((s as any)?.cloud?.businessCode || '').trim();
      if (isAdminContext) {
        setAdminBusinessCode(
          String(businessCode || '')
            .trim()
            .toUpperCase(),
        );
      }
      // Local-first: always load from local DB. Cloud settings are for backup only.
      setCloudNotice(null);
      if (isAdminContext) setAdminBusinessCodeMode(false);

      let users: any[] = [];
      try {
        users = await window.api.auth.listUsers({
          includeAdmins: isAdminContext,
        });
      } catch (e: any) {
        setCloudNotice(e?.message || 'Failed to load users.');
        setStaff([]);
        setOpenIds([]);
        if (!cancelled) {
          setBoot({ staffLoaded: true, openLoaded: true });
          setStaffLoading(false);
        }
        return;
      }
      // Local-first: empty users means no users in database yet.
      if (Array.isArray(users) && users.length === 0) {
        const cloudHint =
          backendUrl && businessCode
            ? ' If using cloud, try Sync from cloud in Settings → Backups.'
            : '';
        setCloudNotice(
          isAdminContext
            ? `No admin users yet. Create the first admin in Settings or run db:seed.${cloudHint}`
            : `No staff users yet. Ask an Admin to add staff members in the Admin panel.${cloudHint}`,
        );
        setStaff([]);
        setOpenIds([]);
        if (!cancelled) {
          setBoot({ staffLoaded: true, openLoaded: true });
          setStaffLoading(false);
        }
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
      setBoot((b) => ({ ...b, staffLoaded: true }));
      if (!isAdminContext) {
        try {
          const ids = await window.api.shifts.listOpen();
          if (cancelled) return;
          setOpenIds(ids);
        } catch (e) {
          void e;
          if (cancelled) return;
          setOpenIds([]);
        } finally {
          if (!cancelled) setBoot((b) => ({ ...b, openLoaded: true }));
        }
      } else {
        setOpenIds([]);
        if (!cancelled) setBoot((b) => ({ ...b, openLoaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce, isAdminContext]);

  const [enableAdmin, setEnableAdmin] = useState(false);

  return (
    <div
      // Pad the page by the iOS safe-area insets so the staff selection
      // card and the PIN modal don't sit under the notch / home indicator,
      // but keep `bg-gray-900` so the WebView still paints those zones
      // (no black bars). `max(...)` keeps the original p-3/sm:p-6 spacing
      // on devices without a safe area.
      className="min-h-dvh flex items-center justify-center bg-gray-900 overflow-hidden px-3 sm:px-6 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-[max(1.5rem,env(safe-area-inset-top))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
    >
      <div className="bg-gray-800 p-4 sm:p-6 rounded-lg w-full max-w-2xl flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-3rem)]">
        <div className="flex items-center justify-between mb-4 shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {/* Back arrow shows only on the PIN screen so the user can
                return to staff selection without it feeling like a modal
                cancel. We reuse `setShowPin(false)` so all the existing
                "leave PIN" cleanup paths stay consistent. */}
            {showPin && (
              <button
                type="button"
                aria-label="Back to staff selection"
                title="Back"
                onClick={() => {
                  setShowPin(false);
                  setPin('');
                  setError(null);
                }}
                className="-ml-1 p-2 rounded hover:bg-gray-700/60 active:bg-gray-700 text-gray-200"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                  aria-hidden
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            <h1 className="text-xl font-semibold truncate">
              {showPin
                ? `Enter PIN${
                    selectedId
                      ? ` for ${staff.find((s) => s.id === selectedId)?.displayName ?? ''}`
                      : ''
                  }`
                : isAdminContext
                  ? 'Admin Login'
                  : 'Select Staff'}
            </h1>
          </div>
          {!showPin && !isAdminContext && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
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
                title="Open the Reservations panel (host login required)"
              >
                Reservations
              </button>
              {!isBrowserClient && enableAdmin && (
                <button
                  className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                  onClick={() => window.api.admin.openWindow()}
                >
                  Admin
                </button>
              )}
            </div>
          )}
        </div>
        {cloudNotice && (
          <div className="mb-4 p-3 rounded bg-amber-900/30 border border-amber-700 text-amber-200 text-sm">
            {cloudNotice}
          </div>
        )}
        {isAdminContext && adminBusinessCodeMode && (
          <div className="mb-4 p-3 rounded border border-gray-700 bg-gray-800/40">
            <div className="text-sm font-medium mb-2">Business code</div>
            <div className="text-xs opacity-70 mb-2">
              Enter your business code to load admin users. After it works, this
              prompt will disappear.
            </div>
            <div className="flex gap-2">
              <input
                className="bg-gray-700 rounded px-3 py-2 flex-1"
                placeholder="Business code (e.g.  Code Orbit)"
                value={adminBusinessCode}
                onChange={(e) =>
                  setAdminBusinessCode(
                    e.target.value
                      .replace(/[^0-9A-Za-z_-]/g, '')
                      .toUpperCase()
                      .slice(0, 24),
                  )
                }
              />
            </div>
            <div className="text-xs opacity-70 mt-3 mb-2">
              Business password (provided by provider)
            </div>
            <div className="flex gap-2">
              <input
                className="bg-gray-700 rounded px-3 py-2 flex-1"
                placeholder="Business password"
                value={adminBusinessPassword}
                onChange={(e) => setAdminBusinessPassword(e.target.value)}
                type="password"
                autoComplete="off"
              />
              <button
                className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60"
                disabled={
                  !adminBusinessCode.trim() ||
                  adminBusinessPassword.trim().length < 6 ||
                  usingCode
                }
                onClick={async () => {
                  setError(null);
                  setCloudNotice('Checking Business code…');
                  setUsingCode(true);
                  try {
                    await window.api.settings.update({
                      cloud: {
                        businessCode: adminBusinessCode.trim(),
                        accessPassword: adminBusinessPassword,
                      },
                    } as any);
                    const users = await window.api.auth.listUsers({
                      includeAdmins: true,
                    });
                    const admins = (users || []).filter(
                      (u: any) => u.role === 'ADMIN' && u.active,
                    );
                    setStaff(admins);
                    if (!admins.length) {
                      setAdminBusinessCodeMode(true);
                      setError('Invalid Business code or Business password.');
                      setCloudNotice(
                        'Invalid Business code or Business password.',
                      );
                    } else {
                      setAdminBusinessCodeMode(false);
                      setCloudNotice(null);
                    }
                  } catch (e: any) {
                    const msg = String(
                      e?.message || 'Failed to set business code',
                    );
                    setError(msg);
                    setCloudNotice(msg);
                    setAdminBusinessCodeMode(true);
                  } finally {
                    setUsingCode(false);
                  }
                }}
              >
                {usingCode ? 'Checking…' : 'Use code'}
              </button>
            </div>
          </div>
        )}
        {!showPin && isAdminContext ? (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="text-sm mb-2 opacity-80 shrink-0">Admins</div>
            <div className="space-y-2 overflow-auto pr-2 flex-1 min-h-0">
              {staff.map((s) => (
                <button
                  key={s.id}
                  className={`w-full rounded cursor-pointer px-3 py-2 border flex items-center justify-between ${selectedId === s.id ? 'bg-emerald-800 border-emerald-500' : 'bg-gray-700 border-transparent'}`}
                  onClick={() => {
                    setSelectedId(s.id);
                    setPin('');
                    setError(null);
                    setShowPin(true);
                  }}
                >
                  <span>{s.displayName}</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="w-4 h-4 opacity-70"
                  >
                    <path d="M12 1.75a5.25 5.25 0 00-5.25 5.25v2.25H5.25A2.25 2.25 0 003 11.5v7.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V11.5a2.25 2.25 0 00-2.25-2.25H17.25V7A5.25 5.25 0 0012 1.75zm-3.75 7.5V7A3.75 3.75 0 0112 3.25 3.75 3.75 0 0115.75 7v2.25h-7.5z" />
                  </svg>
                </button>
              ))}
              {staff.length === 0 && (
                <div className="opacity-70 text-sm">
                  {staffLoading ? 'Loading staff…' : 'No admin users'}
                </div>
              )}
            </div>
          </div>
        ) : !showPin && !isAdminContext ? (
          <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
            <div className="flex flex-col min-h-0">
              <div className="text-sm mb-2 opacity-80 shrink-0">
                Not clocked in
              </div>
              <div className="space-y-2 overflow-auto pr-2 flex-1 min-h-0">
                {staff.length === 0 && !staffLoading && (
                  <div className="opacity-70 text-sm py-4">
                    No staff yet. On the host: Admin → Settings → Backups → Sync
                    from cloud.
                  </div>
                )}
                {staff
                  .filter((s) => !openIds.includes(s.id))
                  .map((s) => (
                    <button
                      key={s.id}
                      className={`w-full rounded cursor-pointer px-3 py-2 border flex items-center justify-between ${selectedId === s.id ? 'bg-emerald-800 border-emerald-500' : 'bg-gray-700 border-transparent'}`}
                      onClick={() => {
                        setSelectedId(s.id);
                        setPin('');
                        setError(null);
                        setShowPin(true);
                      }}
                    >
                      <span>{s.displayName}</span>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="w-4 h-4 opacity-70"
                      >
                        <path d="M12 1.75a5.25 5.25 0 00-5.25 5.25v2.25H5.25A2.25 2.25 0 003 11.5v7.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V11.5a2.25 2.25 0 00-2.25-2.25H17.25V7A5.25 5.25 0 0012 1.75zm-3.75 7.5V7A3.75 3.75 0 0112 3.25 3.75 3.75 0 0115.75 7v2.25h-7.5z" />
                      </svg>
                    </button>
                  ))}
              </div>
            </div>
            <div className="flex flex-col min-h-0">
              <div className="text-sm mb-2 opacity-80 shrink-0">Clocked in</div>
              <div className="space-y-2 overflow-auto pr-2 flex-1 min-h-0">
                {staff
                  .filter((s) => openIds.includes(s.id))
                  .map((s) => (
                    <button
                      key={s.id}
                      className={`w-full rounded cursor-pointer px-3 py-2 border flex items-center justify-between ${selectedId === s.id ? 'bg-emerald-800 border-emerald-500' : 'bg-gray-700 border-transparent'}`}
                      onClick={() => {
                        setSelectedId(s.id);
                        setPin('');
                        setError(null);
                        setShowPin(true);
                      }}
                    >
                      <span>{s.displayName}</span>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="w-4 h-4 opacity-70"
                      >
                        <path d="M12 1.75a5.25 5.25 0 00-5.25 5.25v2.25H5.25A2.25 2.25 0 003 11.5v7.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V11.5a2.25 2.25 0 00-2.25-2.25H17.25V7A5.25 5.25 0 0012 1.75zm-3.75 7.5V7A3.75 3.75 0 0112 3.25 3.75 3.75 0 0115.75 7v2.25h-7.5z" />
                      </svg>
                    </button>
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
          <div className="flex-1 min-h-0 flex flex-col items-center justify-start pt-2 sm:pt-6">
            <div className="w-full max-w-sm flex flex-col gap-3">
              {/* Native numeric keyboard on every client. type="tel" gives
                  iOS/Android a digits-only keyboard without the +/- spinners
                  that "number" introduces. The 20px font size avoids
                  Safari's auto-zoom on focus. */}
              <input
                autoFocus
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="PIN"
                maxLength={6}
                autoComplete="one-time-code"
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D+/g, '').slice(0, 6))
                }
                className="w-full p-3 rounded bg-gray-700 focus:outline-none text-center text-2xl tracking-[0.5em] font-mono"
                style={{ fontSize: '20px' }}
                onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
              />
              {isBrowserClient && (
                <input
                  ref={pairingCodeRef}
                  type="text"
                  inputMode="numeric"
                  placeholder="Pairing code (from Admin)"
                  maxLength={12}
                  defaultValue={pairingCode}
                  className="w-full p-3 rounded bg-gray-700 focus:outline-none"
                  onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                />
              )}
              {error && <div className="text-red-400 text-sm">{error}</div>}
              <button
                onClick={onSubmit}
                className="w-full bg-emerald-600 hover:bg-emerald-700 py-3 rounded font-semibold"
              >
                Login
              </button>
            </div>
          </div>
        )}

        {!isAdminContext && showShiftConfirm && pendingUser && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center">
            <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
              <h2 className="text-center mb-3">
                Start shift for {pendingUser.displayName}?
              </h2>
              <div className="flex gap-2 mt-2">
                <button
                  className="flex-1 bg-gray-600 py-2 rounded"
                  onClick={() => {
                    setShowShiftConfirm(false);
                    setPendingUser(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded"
                  onClick={async () => {
                    try {
                      const ae = document.activeElement as HTMLElement | null;
                      if (ae && typeof ae.blur === 'function') ae.blur();
                    } catch {
                      // ignore
                    }
                    await window.api.shifts.clockIn(pendingUser.id);
                    setShowShiftConfirm(false);
                    setPendingUser(null);
                    setUser(pendingUser);
                    navigate(isKdsContext ? '/kds' : '/app/tables');
                  }}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
