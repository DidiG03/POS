import { Link } from 'react-router-dom';
export default function HomePage() {

  return (
    <div className="h-full flex gap-4 justify-center items-center">
      <Link to="/app/order" className="flex items-center justify-center h-full w-1/5 border-2 border-emerald-700 hover:border-emerald-800 hover:bg-emerald-700 transition-all duration-300 p-6 rounded text-center font-bold">New Order</Link>
      <Link to="/app/tables" className="flex items-center justify-center h-full w-1/5 border-2 border-emerald-700 hover:border-emerald-800 hover:bg-emerald-700  transition-all duration-300 p-6 rounded text-center font-bold">Tables</Link>
    </div>
  );
}


