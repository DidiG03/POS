import { Link } from 'react-router-dom';

export default function HomePage() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      <Link to="/app/order" className="bg-gray-700 p-6 rounded text-center">New Order (F1)</Link>
      <Link to="/app/tables" className="bg-gray-700 p-6 rounded text-center">Tables</Link>
      <Link to="/app/reports" className="bg-gray-700 p-6 rounded text-center">Reports</Link>
      <Link to="/app/settings" className="bg-gray-700 p-6 rounded text-center">Settings</Link>
    </div>
  );
}


