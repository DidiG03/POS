import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReservationSessionStore } from '../../stores/reservationSession';
import type { UserDTO } from '@shared/ipc';

// Mirrored from LoginPage so a tablet that paired through the staff
// login is recognised here without re-entering the code.
const PAIRING_STORAGE_KEY = 'pos_pairing_code';

type StaffEntry = Pick<UserDTO, 'id' | 'displayName' | 'role'> & {
  active?: boolean;
};

export default function ReservationsLoginPage() {
  const navigate = useNavigate();
  const setUser = useReservationSessionStore((s) => s.setUser);
  const sessionUser = useReservationSessionStore((s) => s.user);
  const sessionExpiresAt = useReservationSessionStore((s) => s.expiresAtMs);

  const [staff, setStaff] = useState<StaffEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Pairing code: pre-loaded from a previous staff/host login, but the
  // input is always shown on browser clients so a fresh device can pair.
  const pairingCodeRef = useRef<HTMLInputElement>(null);
  const [pairingCode, setPairingCode] = useState<string>(() => {
    try {
      return localStorage.getItem(PAIRING_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });

  // True inside the Capacitor / browser shell. Electron sets no flag and
  // opens this page in a dedicated window, so the back-to-staff-login
  // affordance only makes sense on mobile/web.
  const isBrowserClient =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);

  // Auto-redirect if a non-expired session already exists.
  useEffect(() => {
    if (sessionUser && (!sessionExpiresAt || sessionExpiresAt > Date.now())) {
      navigate('/reservations/app', { replace: true });
    }
  }, [sessionUser, sessionExpiresAt, navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Need admins included so the role filter below can pick them up.
        const users = await window.api.auth.listUsers({ includeAdmins: true });
        if (cancelled) return;
        const filtered = (users || [])
          .filter((u: any) => u && u.active !== false)
          .filter((u: any) => {
            const r = String(u.role || '').toUpperCase();
            return r === 'HOST' || r === 'ADMIN';
          })
          .map((u: any) => ({
            id: Number(u.id),
            displayName: String(u.displayName || ''),
            role: String(u.role || ''),
            active: u.active !== false,
          }));
        setStaff(filtered as any);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load users.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedStaff = useMemo(
    () =>
      [...staff].sort((a, b) => {
        // Admins first, then alphabetic
        const ar = String(a.role).toUpperCase() === 'ADMIN' ? 0 : 1;
        const br = String(b.role).toUpperCase() === 'ADMIN' ? 0 : 1;
        if (ar !== br) return ar - br;
        return a.displayName.localeCompare(b.displayName);
      }),
    [staff],
  );

  async function submit() {
    setError(null);
    if (!selectedId) {
      setError('Choose your name first.');
      return;
    }
    if (pin.length < 4) {
      setError('Enter your PIN (4-6 digits).');
      return;
    }
    // Dismiss the soft keyboard before the async login + navigation so the
    // viewport reflow happens once, before the new page paints. Otherwise
    // iOS keeps the keyboard up through navigation and the screen visibly
    // jitters when it finally collapses.
    try {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && typeof ae.blur === 'function') ae.blur();
    } catch {
      // ignore
    }
    setSubmitting(true);
    try {
      // The browser/mobile shell requires a pairing code (when pairing is
      // enforced in settings). Prefer what's currently in the visible
      // input; fall back to whatever was cached from a previous successful
      // login on this device.
      const codeFromInput =
        pairingCodeRef.current?.value
          ?.trim()
          .replace(/[^0-9A-Za-z]/g, '')
          .slice(0, 12) || '';
      const effectivePairingCode = isBrowserClient
        ? codeFromInput || pairingCode || undefined
        : undefined;
      const user = await window.api.auth.loginWithPin(
        pin,
        selectedId,
        effectivePairingCode,
      );
      const role = String((user as any)?.role || '').toUpperCase();
      if (!user || (role !== 'HOST' && role !== 'ADMIN')) {
        setError('Only Hosts or Admins can sign in here.');
        setPin('');
        return;
      }
      // Persist the code so subsequent reloads on this device skip the input.
      if (isBrowserClient && effectivePairingCode) {
        try {
          localStorage.setItem(PAIRING_STORAGE_KEY, effectivePairingCode);
          setPairingCode(effectivePairingCode);
          if (pairingCodeRef.current)
            pairingCodeRef.current.value = effectivePairingCode;
        } catch {
          // ignore — quota / private mode just means we'll re-prompt next time
        }
      }
      setUser(user as any);
      navigate('/reservations/app', { replace: true });
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      // The server rejected the pairing code (or none was sent). Drop the
      // stale value so the input is empty + ready for the manager to type
      // the fresh code from Admin → Settings → LAN / Tablets.
      if (msg.toLowerCase().includes('pairing code')) {
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
        setPin('');
      } else {
        setError(msg || 'Login failed.');
        setPin('');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="min-h-dvh flex items-start sm:items-center justify-center bg-gray-900 text-gray-100 p-3 sm:p-4"
      style={{
        paddingTop: 'max(env(safe-area-inset-top), 0.75rem)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)',
      }}
    >
      <div className="w-full max-w-3xl bg-gray-800 rounded-lg shadow-xl p-4 sm:p-6">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="flex items-start gap-3 min-w-0">
            {/* Back arrow returns to the staff login. Only shown on the
                mobile/browser shell — on Electron desktop the reservation
                panel runs in its own dedicated window, so there's no
                staff login to go back to. We always navigate with
                `replace` so the host login isn't kept in history,
                otherwise the system back gesture on iOS could bounce the
                user between the two login screens. */}
            {isBrowserClient && (
              <button
                type="button"
                aria-label="Back to staff login"
                title="Back"
                onClick={() => navigate('/', { replace: true })}
                className="shrink-0 -ml-1 p-2 rounded hover:bg-gray-700/60 active:bg-gray-700 text-gray-200"
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
            <div className="min-w-0">
              <div className="text-2xl font-semibold">Reservations</div>
              <div className="text-sm opacity-70">
                Sign in as a Host or Admin to manage today&apos;s bookings.
              </div>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="opacity-70 text-sm">Loading…</div>
        ) : sortedStaff.length === 0 ? (
          <div className="bg-amber-900/30 border border-amber-700 rounded p-3 text-sm">
            No Host or Admin users yet. Ask an Admin to add a Host in the Admin
            panel (Staff section, role: HOST).
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <div className="text-xs uppercase tracking-wide opacity-70 mb-2">
                Who&apos;s logging in?
              </div>
              <div className="flex flex-col gap-2 max-h-80 overflow-y-auto pr-1">
                {sortedStaff.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className={`w-full text-left rounded px-3 py-2 border flex items-center justify-between gap-3 ${
                      selectedId === u.id
                        ? 'bg-blue-600 border-blue-400'
                        : 'bg-gray-700 hover:bg-gray-600 border-gray-700'
                    }`}
                    onClick={() => setSelectedId(u.id)}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {u.displayName}
                      </div>
                    </div>
                    <span
                      className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap ${
                        String(u.role).toUpperCase() === 'ADMIN'
                          ? 'bg-amber-900/40 border-amber-700 text-amber-100'
                          : 'bg-emerald-900/40 border-emerald-700 text-emerald-100'
                      }`}
                    >
                      {u.role}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs uppercase tracking-wide opacity-70 mb-2">
                PIN
              </div>
              {/* Native numeric keyboard. type="tel" reliably surfaces the
                  digits-only keyboard on iOS/Android without the spinners
                  that "number" introduces. The 20px font size keeps Safari
                  from auto-zooming on focus. */}
              <input
                autoFocus={!!selectedId}
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Enter PIN"
                maxLength={6}
                autoComplete="one-time-code"
                value={pin}
                onChange={(e) => {
                  setError(null);
                  setPin(e.target.value.replace(/\D+/g, '').slice(0, 6));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                className="w-full px-3 py-3 rounded bg-gray-900 text-center text-3xl tracking-[0.5em] font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                style={{ fontSize: '20px' }}
              />
              {/* Pairing code input: only browser / mobile clients need it.
                  Electron desktop opens this page in a child window of the
                  host POS app, so the LAN guard already trusts it. */}
              {isBrowserClient && (
                <div className="mt-3">
                  <div className="text-xs uppercase tracking-wide opacity-70 mb-2">
                    Pairing code
                  </div>
                  <input
                    ref={pairingCodeRef}
                    type="text"
                    inputMode="numeric"
                    placeholder="Pairing code (from Admin)"
                    maxLength={12}
                    defaultValue={pairingCode}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full px-3 py-3 rounded bg-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-base"
                    style={{ fontSize: '16px' }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submit();
                    }}
                  />
                </div>
              )}
              <button
                type="button"
                disabled={submitting}
                className="mt-4 w-full px-3 py-3 rounded bg-emerald-600 hover:bg-emerald-500 font-semibold disabled:opacity-50"
                onClick={submit}
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
              {error && (
                <div className="mt-2 text-sm text-rose-300">{error}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
