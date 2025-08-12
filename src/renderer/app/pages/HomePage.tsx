import { Link } from 'react-router-dom';

export default function HomePage() {
  return (
    <div className="h-full flex gap-4 justify-center items-center">
      <Link to="/app/order" className="w-1/2 bg-emerald-700 hover:bg-emerald-800 transition-all duration-300 p-6 rounded text-center font-bold">New Order</Link>
      <Link to="/app/tables" className="w-1/2 bg-blue-800 hover:bg-blue-900 transition-all duration-300 p-6 rounded text-center font-bold">Tables</Link>
    </div>
  );
}


