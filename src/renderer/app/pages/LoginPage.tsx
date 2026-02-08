import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/session';
import { useAdminSessionStore } from '../../stores/adminSession';
import { isClockOnlyRole } from '@shared/utils/roles';

export default function LoginPage() {
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [businessCode, setBusinessCode] = useState<string>(() => {
    try {
      return (localStorage.getItem('pos_business_code') || '')
        .trim()
        .toUpperCase();
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
    if (
      isBrowserClient &&
      isCloudBrowserClient &&
      businessCode.trim().length < 2
    ) {
      setError('Enter your Business code');
      return;
    }
    if (pin.length < 4) {
      setError('Enter 4-6 digits');
      return;
    }
    try {
      // In browser cloud mode, persist business code locally so auth.listUsers/login can use it.
      if (isBrowserClient && isCloudBrowserClient) {
        try {
          localStorage.setItem(
            'pos_business_code',
            businessCode.trim().toUpperCase(),
          );
        } catch {
          // ignore
        }
      }
      const user = await window.api.auth.loginWithPin(
        pin,
        selectedId ?? undefined,
        isBrowserClient ? pairingCode || undefined : undefined,
      );
      if (user) {
        const clockOnly = isClockOnlyRole((user as any).role);
        if (isAdminContext && user.role !== 'ADMIN') {
          setError('Admin access only');
          return;
        }
        // Admin goes straight to admin shell
        if (user.role === 'ADMIN') {
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
  const [boot, setBoot] = useState<{
    staffLoaded: boolean;
    openLoaded: boolean;
  }>({ staffLoaded: false, openLoaded: false });
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
      if (backendUrl && !businessCode) {
        // Cloud is enabled by provider, but tenant not selected → block local fallback.
        setCloudNotice(
          'Cloud is enabled. Enter your Business code + Business password to continue.',
        );
        // In admin window, allow entering business code directly from login screen.
        if (isAdminContext) setAdminBusinessCodeMode(true);
        setStaff([]);
        setOpenIds([]);
        if (!cancelled) setBoot({ staffLoaded: true, openLoaded: true });
        return;
      }
      setCloudNotice(null);
      if (isAdminContext) setAdminBusinessCodeMode(false);

      let users: any[] = [];
      try {
        users = await window.api.auth.listUsers({
          includeAdmins: isAdminContext,
        });
      } catch (e: any) {
        // Most common: wrong business code/password or cloud temporarily unavailable.
        if (backendUrl && isAdminContext) setAdminBusinessCodeMode(true);
        if (backendUrl) {
          setCloudNotice(
            e?.message || 'Invalid Business code or Business password.',
          );
          setStaff([]);
          setOpenIds([]);
          if (!cancelled) setBoot({ staffLoaded: true, openLoaded: true });
          return;
        }
        throw e;
      }
      // In cloud mode, auth.listUsers may return [] when businessCode/password is wrong.
      // Since every tenant must have at least one admin user, treat empty list as invalid credentials.
      if (
        backendUrl &&
        businessCode &&
        Array.isArray(users) &&
        users.length === 0
      ) {
        if (isAdminContext) {
          setAdminBusinessCodeMode(true);
          // Show a clear hint: server returns [] for wrong/missing business password (enumeration protection),
          // which otherwise looks like the restaurant "disappeared".
          setCloudNotice('Invalid Business code or Business password.');
          setStaff([]);
          setOpenIds([]);
          if (!cancelled) setBoot({ staffLoaded: true, openLoaded: true });
          return;
        }
        // Staff login: empty staff list can also mean "no staff created yet".
        // If we can fetch admins (includeAdmins=1), then credentials are valid and the tenant exists.
        try {
          const all = await window.api.auth.listUsers({ includeAdmins: true });
          const hasAdmins =
            Array.isArray(all) &&
            all.some(
              (u: any) => String(u?.role || '').toUpperCase() === 'ADMIN',
            );
          setCloudNotice(
            hasAdmins
              ? 'No staff users yet. Ask an Admin to add staff members in the Admin panel.'
              : 'Cloud is enabled but staff list is locked. Ask an Admin to enter the Business code + Business password in the Admin login screen.',
          );
        } catch {
          setCloudNotice(
            'Cloud is enabled but staff list is locked. Ask an Admin to enter the Business code + Business password in the Admin login screen.',
          );
        }
        setStaff([]);
        setOpenIds([]);
        if (!cancelled) setBoot({ staffLoaded: true, openLoaded: true });
        return;
      }
      const list = isAdminContext
        ? users.filter((u) => u.role === 'ADMIN' && u.active)
        : users.filter((u) => u.active && u.role !== 'ADMIN');
      if (cancelled) return;
      setStaff(list);
      setBoot((b) => ({ ...b, staffLoaded: true }));
      // If cloud returned only admins (common when billing is paused), explain why staff list is empty.
      if (!isAdminContext && backendUrl) {
        const hasAdmins =
          Array.isArray(users) &&
          users.some(
            (u: any) => String(u?.role || '').toUpperCase() === 'ADMIN',
          );
        if (hasAdmins && list.length === 0) {
          setCloudNotice(
            'POS is paused (payment required). Only admins can log in until billing is completed.',
          );
        }
      }
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

  const shouldShowBootLoader =
    // If we need user input (business code/password), show that UI instead of a loader.
    !cloudNotice &&
    !(isAdminContext && adminBusinessCodeMode) &&
    (isAdminContext ? !boot.staffLoaded : !(boot.staffLoaded && boot.openLoaded));

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      {shouldShowBootLoader ? (
        <div className="w-full max-w-md bg-gray-800 border border-gray-700 rounded p-6 text-gray-100">
          <div className="text-lg font-semibold mb-2">
            Connecting to POS backend…
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <div className="text-xs opacity-70">Please wait…</div>
          </div>
        </div>
      ) : (
        <div className="bg-gray-800 p-6 rounded-lg w-full max-w-2xl">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold">
            {isAdminContext ? 'Admin Login' : 'Select Staff'}
          </h1>
          {enableAdmin && !isAdminContext && (
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
          <div>
            <div className="text-sm mb-2 opacity-80">Admins</div>
            <div className="space-y-2 max-h-64 overflow-auto pr-2">
              {staff.map((s) => (
                <button
                  key={s.id}
                  className={`w-full rounded cursor-pointer px-3 py-2 border flex items-center justify-between ${selectedId === s.id ? 'bg-emerald-800 border-emerald-500' : 'bg-gray-700 border-transparent'}`}
                  onClick={() => {
                    setSelectedId(s.id);
                    setPin('');
                    setPairingCode('');
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
                <div className="opacity-70 text-sm">No admin users</div>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-sm mb-2 opacity-80">Not clocked in</div>
              <div className="space-y-2 max-h-64 overflow-auto pr-2">
                {staff
                  .filter((s) => !openIds.includes(s.id))
                  .map((s) => (
                    <button
                      key={s.id}
                      className={`w-full rounded cursor-pointer px-3 py-2 border flex items-center justify-between ${selectedId === s.id ? 'bg-emerald-800 border-emerald-500' : 'bg-gray-700 border-transparent'}`}
                      onClick={() => {
                        setSelectedId(s.id);
                        setPin('');
                        setPairingCode('');
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
            <div>
              <div className="text-sm mb-2 opacity-80">Clocked in</div>
              <div className="space-y-2 max-h-64 overflow-auto pr-2">
                {staff
                  .filter((s) => openIds.includes(s.id))
                  .map((s) => (
                    <button
                      key={s.id}
                      className={`w-full rounded cursor-pointer px-3 py-2 border flex items-center justify-between ${selectedId === s.id ? 'bg-emerald-800 border-emerald-500' : 'bg-gray-700 border-transparent'}`}
                      onClick={() => {
                        setSelectedId(s.id);
                        setPin('');
                        setPairingCode('');
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
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
            <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
              <h2 className="text-center mb-3">
                Enter PIN for{' '}
                {staff.find((s) => s.id === selectedId)?.displayName}
              </h2>
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
              {isBrowserClient && isCloudBrowserClient && (
                <input
                  type="text"
                  inputMode="text"
                  placeholder="Business code (e.g. MYRESTAURANT)"
                  maxLength={24}
                  value={businessCode}
                  onChange={(e) =>
                    setBusinessCode(
                      e.target.value
                        .replace(/[^0-9A-Za-z_-]/g, '')
                        .toUpperCase()
                        .slice(0, 24),
                    )
                  }
                  className="w-full p-3 rounded bg-gray-700 focus:outline-none mt-2"
                  onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                />
              )}
              {isBrowserClient && (
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Pairing code (from Admin)"
                  maxLength={12}
                  value={pairingCode}
                  onChange={(e) =>
                    setPairingCode(
                      e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 12),
                    )
                  }
                  className="w-full p-3 rounded bg-gray-700 focus:outline-none mt-2"
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
      )}
    </div>
  );
}
