import { Link, Outlet } from 'react-router-dom';

export default function AppLayout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="font-semibold">Ullishtja POS</div>
        <nav className="space-x-4">
          <Link to="/app" className="hover:underline">Home</Link>
          <Link to="/app/tables" className="hover:underline">Tables</Link>
          <Link to="/app/order" className="hover:underline">Order</Link>
          <Link to="/app/reports" className="hover:underline">Reports</Link>
          <Link to="/app/settings" className="hover:underline">Settings</Link>
        </nav>
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}


