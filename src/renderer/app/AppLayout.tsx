import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/session';

export default function AppLayout() {
  const { user, setUser } = useSessionStore();
  const [hasOpen, setHasOpen] = useState<boolean>(false);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      if (!user) return;
      const open = await window.api.shifts.getOpen(user.id);
      setHasOpen(Boolean(open));
    })();
  }, [user]);
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="font-semibold">Ullishtja Agrotourizem</div>
        <nav className="space-x-4">
          <Link to="/app" className="hover:underline">Home</Link>
          <Link to="/app/tables" className="hover:underline">Tables</Link>
          <Link to="/app/order" className="hover:underline">Order</Link>
          <Link to="/app/reports" className="hover:underline">Reports</Link>
          <Link to="/app/settings" className="hover:underline">Settings</Link>
          {user && (
            <>
              {hasOpen && (
                <button
                  className="ml-4 px-3 py-1 rounded bg-red-600 hover:bg-red-700"
                  onClick={async () => {
                    await window.api.shifts.clockOut(user.id);
                    setHasOpen(false);
                    setUser(null);
                    navigate('/');
                  }}
                >
                  Clock out
                </button>
              )}
              <button
                className="ml-2 px-3 py-1 rounded bg-gray-600 hover:bg-gray-700"
                onClick={() => {
                  setUser(null);
                  navigate('/');
                }}
              >
                Log out
              </button>
            </>
          )}
        </nav>
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}


