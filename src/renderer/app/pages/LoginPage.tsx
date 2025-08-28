import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/session';

export default function LoginPage() {
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const onSubmit = async () => {
    setError(null);
    if (pin.length < 4) {
      setError('Enter 4-6 digits');
      return;
    }
    try {
      const user = await window.api.auth.loginWithPin(pin, selectedId ?? undefined);
      if (user) {
        // Check for open shift; if none, ask to start
        const open = await window.api.shifts.getOpen(user.id);
        if (!open) {
          const confirmStart = true; // simple confirm modal below
          setShowShiftConfirm(true);
          setPendingUser(user);
          return;
        }
        setUser(user);
        navigate('/app/tables');
      }
      else setError('Invalid PIN');
    } catch (e) {
      console.error(e);
      setError('Login failed');
    }
  };

  const [staff, setStaff] = useState<{ id: number; displayName: string }[]>([]);
  const [openIds, setOpenIds] = useState<number[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showShiftConfirm, setShowShiftConfirm] = useState(false);
  const [pendingUser, setPendingUser] = useState<any>(null);
  const { setUser } = useSessionStore();
  useEffect(() => {
    (async () => {
      try {
        await window.api.auth.syncStaffFromApi();
      } catch {}
      const users = await window.api.auth.listUsers();
      const activeUsers = users.filter((u) => u.active && u.role !== 'ADMIN');
      setStaff(activeUsers);
      try {
        const ids = await window.api.shifts.listOpen();
        setOpenIds(ids);
      } catch {}
      // Read admin flag for showing admin button
      const s = await window.api.settings.get();
      setEnableAdmin(s.enableAdmin ?? false);
    })();
  }, []);

  const [enableAdmin, setEnableAdmin] = useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="bg-gray-800 p-6 rounded-lg w-full max-w-2xl">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold">Select Staff</h1>
          {enableAdmin && (
            <button
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
              onClick={() => window.api.admin.openWindow()}
            >
              Admin
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm mb-2 opacity-80">Not clocked in</div>
            <div className="space-y-2 max-h-64 overflow-auto pr-2">
              {staff.filter((s) => !openIds.includes(s.id)).map((s) => (
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
          <div>
            <div className="text-sm mb-2 opacity-80">Clocked in</div>
            <div className="space-y-2 max-h-64 overflow-auto pr-2">
              {staff.filter((s) => openIds.includes(s.id)).map((s) => (
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
        {showPin && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
            <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
              <h2 className="text-center mb-3">Enter PIN for {staff.find((s) => s.id === selectedId)?.displayName}</h2>
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
              {error && <div className="text-red-400 mt-2 text-sm">{error}</div>}
              <div className="flex gap-2 mt-4">
                <button onClick={() => setShowPin(false)} className="flex-1 bg-gray-600 py-2 rounded">Cancel</button>
                <button onClick={onSubmit} className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded">Login</button>
              </div>
            </div>
          </div>
        )}

        {showShiftConfirm && pendingUser && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
            <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
              <h2 className="text-center mb-3">Start shift for {pendingUser.displayName}?</h2>
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
                    navigate('/app');
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


