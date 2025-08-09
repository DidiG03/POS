export default function OrderPage() {
  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="col-span-2">
        <input placeholder="Search menu (F2)" className="w-full p-2 bg-gray-700 rounded mb-3" />
        <div className="grid grid-cols-3 gap-2">
          {['Salad', 'Pizza', 'Pasta', 'Grill', 'Fish', 'Drinks'].map((c) => (
            <button key={c} className="bg-gray-700 py-4 rounded">{c}</button>
          ))}
        </div>
      </div>
      <div className="bg-gray-800 p-3 rounded">
        <div className="font-semibold mb-2">Ticket</div>
        <div className="h-64 overflow-auto space-y-2">
          <div className="flex justify-between"><span>Espresso x2</span><span>4.00</span></div>
        </div>
        <div className="border-t border-gray-700 mt-3 pt-3 space-y-1 text-sm">
          <div className="flex justify-between"><span>Subtotal</span><span>4.00</span></div>
          <div className="flex justify-between"><span>VAT</span><span>0.80</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span>4.80</span></div>
        </div>
        <button className="mt-3 w-full bg-emerald-600 py-2 rounded">Pay (F9)</button>
      </div>
    </div>
  );
}


