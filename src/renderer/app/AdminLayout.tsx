import { Link, Outlet } from 'react-router-dom';

export default function AdminLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
      <header className="bg-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="font-semibold">Ullishtja POS Admin</div>
        <nav className="space-x-3 text-sm">
          <Link to="/admin" className="hover:underline">Overview</Link>
          <button
            className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
            onClick={() => window.api.auth.syncStaffFromApi()}
          >
            Sync Staff
          </button>
          <button
            className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
            onClick={() => window.api.settings.testPrint()}
          >
            Test Printer
          </button>
          <button
            className="ml-2 px-3 py-1 rounded bg-red-600 hover:bg-red-700"
            onClick={() => window.close()}
          >
            Close
          </button>
        </nav>
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}


