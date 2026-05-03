import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/session';
import { useAdminSessionStore } from '../../stores/adminSession';
import { isClockOnlyRole } from '@shared/utils/roles';

// In-app numeric keypad for PIN entry on mobile.
//
// The native iOS keyboard takes 1–2 s to appear on a cold simulator launch and
// every keystroke goes through WKWebView's text-input pipeline, which adds
// noticeable latency for short codes. Rendering a button grid in JS bypasses
// all of that — taps land in the same React tick that paints the next dot.
function PinKeypad({
  pin,
  setPin,
  maxLength,
  onSubmit,
}: {
  pin: string;
  setPin: (next: string) => void;
  maxLength: number;
  onSubmit: () => void;
}) {
  const handleDigit = useCallback(
    (digit: string) => {
      if (pin.length >= maxLength) return;
      // Light haptic feedback on real iOS devices (Capacitor exposes
      // navigator.vibrate via its WebView shim). No-op on desktop.
      try {
        navigator.vibrate?.(10);
      } catch {
        /* ignore */
      }
      setPin(pin + digit);
    },
    [pin, maxLength, setPin],
  );

  const handleBackspace = useCallback(() => {
    if (!pin.length) return;
    setPin(pin.slice(0, -1));
  }, [pin, setPin]);

  // Allow physical keyboards (iPad with Smart Keyboard, browser dev) to type
  // the PIN even though we never focus a real input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onSubmit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleDigit, handleBackspace, onSubmit]);

  const dots = Array.from({ length: maxLength }, (_, i) => i < pin.length);
  const keys: { label: string; onPress: () => void; variant?: 'digit' | 'action' }[] = [
    { label: '1', onPress: () => handleDigit('1') },
    { label: '2', onPress: () => handleDigit('2') },
    { label: '3', onPress: () => handleDigit('3') },
    { label: '4', onPress: () => handleDigit('4') },
    { label: '5', onPress: () => handleDigit('5') },
    { label: '6', onPress: () => handleDigit('6') },
    { label: '7', onPress: () => handleDigit('7') },
    { label: '8', onPress: () => handleDigit('8') },
    { label: '9', onPress: () => handleDigit('9') },
    { label: '⌫', onPress: handleBackspace, variant: 'action' },
    { label: '0', onPress: () => handleDigit('0') },
    { label: '⏎', onPress: onSubmit, variant: 'action' },
  ];

  return (
    <div className="select-none">
      <div
        className="flex items-center justify-center gap-3 mb-4 h-10"
        aria-label={`PIN, ${pin.length} of ${maxLength} digits entered`}
        role="status"
      >
        {dots.map((filled, i) => (
          <div
            key={i}
            className={`w-3 h-3 rounded-full transition-colors ${filled ? 'bg-emerald-400' : 'bg-gray-600'}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {keys.map((k) => (
          <button
            key={k.label}
            type="button"
            onClick={k.onPress}
            className={`h-14 rounded-lg text-2xl font-semibold active:scale-95 transition-transform ${
              k.variant === 'action'
                ? 'bg-gray-700 hover:bg-gray-600 text-emerald-300'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-100'
            }`}
            // Disable iOS long-press / context menus for cleaner taps.
            onContextMenu={(e) => e.preventDefault()}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}

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
    try {
      const codeFromInput = pairingCodeRef.current?.value?.trim().replace(/[^0-9A-Za-z]/g, '').slice(0, 12) || '';
      const effectivePairingCode = isBrowserClient
        ? (codeFromInput || pairingCode) || undefined
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
          if (pairingCodeRef.current) pairingCodeRef.current.value = effectivePairingCode;
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
        if (!cancelled) { setBoot({ staffLoaded: true, openLoaded: true }); setStaffLoading(false); }
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
        if (!cancelled) { setBoot({ staffLoaded: true, openLoaded: true }); setStaffLoading(false); }
        return;
      }
      const list = isAdminContext
        ? users.filter((u) => u.role === 'ADMIN' && u.active)
        : users.filter((u) => u.active && u.role !== 'ADMIN');
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
    <div className="min-h-dvh flex items-center justify-center bg-gray-900 p-3 sm:p-6 overflow-hidden">
        <div className="bg-gray-800 p-4 sm:p-6 rounded-lg w-full max-w-2xl flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-3rem)]">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h1 className="text-xl font-semibold">
            {isAdminContext ? 'Admin Login' : 'Select Staff'}
          </h1>
          {enableAdmin && !isAdminContext && !isBrowserClient && (
            <button
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
              onClick={() => window.api.admin.openWindow()}
            >
              Admin
            </button>
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
        {isAdminContext ? (
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
        ) : (
          <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
            <div className="flex flex-col min-h-0">
              <div className="text-sm mb-2 opacity-80 shrink-0">Not clocked in</div>
              <div className="space-y-2 overflow-auto pr-2 flex-1 min-h-0">
                {staff.length === 0 && !staffLoading && (
                  <div className="opacity-70 text-sm py-4">
                    No staff yet. On the host: Admin → Settings → Backups → Sync from cloud.
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
        )}
        {showPin && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-3 z-50">
            <div className="bg-gray-800 p-5 rounded w-full max-w-sm max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
              <h2 className="text-center mb-3">
                Enter PIN for{' '}
                {staff.find((s) => s.id === selectedId)?.displayName}
              </h2>
              {isBrowserClient ? (
                // Mobile: in-app keypad — eliminates iOS keyboard latency.
                // The same render-tick that fires the tap also paints the new
                // dot, so there's no perceptible delay.
                <PinKeypad
                  pin={pin}
                  setPin={setPin}
                  maxLength={6}
                  onSubmit={onSubmit}
                />
              ) : (
                // Desktop (Electron): keep the native input so admins can use
                // a physical keyboard and barcode/key-fob readers if they want.
                <input
                  autoFocus
                  type="password"
                  inputMode="numeric"
                  placeholder="PIN"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
                  className="w-full p-3 rounded bg-gray-700 focus:outline-none"
                  onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                />
              )}
              {isBrowserClient && (
                <input
                  ref={pairingCodeRef}
                  type="text"
                  inputMode="numeric"
                  placeholder="Pairing code (from Admin)"
                  maxLength={12}
                  defaultValue={pairingCode}
                  className="w-full p-3 rounded bg-gray-700 focus:outline-none mt-3"
                  onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                />
              )}
              {error && (
                <div className="text-red-400 mt-2 text-sm">{error}</div>
              )}
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setShowPin(false)}
                  className="flex-1 bg-gray-600 py-2 rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={onSubmit}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded"
                >
                  Login
                </button>
              </div>
            </div>
          </div>
        )}

        {!isAdminContext && showShiftConfirm && pendingUser && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
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
