import { useEffect, useMemo, useState } from 'react';
import { useTicketStore } from '../../stores/ticket';
import { useOrderContext } from '../../stores/orderContext';
import { useTableStatus } from '../../stores/tableStatus';
import { useNavigate } from 'react-router-dom';

type MenuItemDTO = {
  id: number;
  name: string;
  sku: string;
  price: number;
  vatRate: number;
  active: boolean;
  categoryId: number;
};
type MenuCategoryDTO = {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  items: MenuItemDTO[];
};

export default function OrderPage() {
  const [categories, setCategories] = useState<MenuCategoryDTO[]>([]);
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [syncing, setSyncing] = useState(false);
  const { lines, addItem, increment, decrement, setLineNote, orderNote, setOrderNote, clear } = useTicketStore();
  const { selectedTable, setPendingAction } = useOrderContext();
  const { setOpen, isOpen } = useTableStatus();
  const [showCovers, setShowCovers] = useState(false);
  const [coversValue, setCoversValue] = useState('');
  const navigate = useNavigate();

  const selected = useMemo(
    () => categories.find((c) => c.id === selectedCatId) ?? categories[0],
    [categories, selectedCatId],
  );

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    // If there is a search query, search across all categories' items
    if (q) {
      return categories.flatMap((c) => c.items).filter(
        (i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)
      );
    }
    // Otherwise, show items from the selected category (or first category)
    return selected ? selected.items : categories.flatMap((c) => c.items);
  }, [categories, selected, query]);

  const loadMenu = async () => {
    const data = await window.api.menu.listCategoriesWithItems();
    setCategories(data);
    if (data.length && !selectedCatId) setSelectedCatId(data[0].id);
  };

  useEffect(() => {
    loadMenu();
  }, []);

  const syncMenu = async () => {
    setSyncing(true);
    try {
      const url = (window as any).MENU_API_URL || undefined;
      await window.api.menu.syncFromUrl({ url: url || 'https://ullishtja-agroturizem.com/api/pos-menu?lang=en' });
      await loadMenu();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div style={{ height: 'calc(100vh - 90px)' }} className="grid grid-cols-3 gap-4 min-h-0">
      <div className="col-span-2 min-h-full overflow-auto">
        <div className="flex gap-2 mb-3">
          <input
            placeholder="Search Menu..."
            className="w-full p-2 bg-gray-700 rounded"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button onClick={syncMenu} className="px-3 bg-gray-700 rounded whitespace-nowrap">
            {syncing ? 'Syncing…' : 'Sync menu'}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCatId(c.id)}
              className={`py-7 px-2 border border-gray-700 cursor-pointer rounded ${selected?.id === c.id ? 'bg-emerald-800' : 'bg-gray-900'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {filteredItems.map((i) => (
            <button
              key={i.id}
              className="bg-yellow-800 py-4 rounded text-left px-3 cursor-pointer"
              onClick={() => addItem({ sku: i.sku, name: i.name, unitPrice: i.price, vatRate: i.vatRate })}
            >
              <div className="font-medium">{i.name}</div>
              <div className="text-sm">{i.price.toFixed(2)}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="bg-gray-800 p-3 rounded flex flex-col h-full min-h-0">
        <div className="font-semibold mb-2">Ticket {selectedTable ? `- ${selectedTable.label}` : ''}</div>
        <div className="flex-1 overflow-auto space-y-2">
          {lines.length === 0 ? (
            <div className="text-sm opacity-60">Select items to add…</div>
          ) : (
            lines.map((l) => (
              <div key={l.id} className="bg-gray-700 rounded px-2 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{l.name}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="px-2 bg-gray-600 rounded" onClick={() => decrement(l.id)}>-</button>
                    <div className="w-6 text-center">{l.qty}</div>
                    <button className="px-2 bg-gray-600 rounded" onClick={() => increment(l.id)}>+</button>
                    <div className="w-20 text-right">{(l.unitPrice * l.qty).toFixed(2)}</div>
                  </div>
                </div>
                <input
                  className="mt-2 w-full bg-gray-600 rounded px-2 py-1 text-sm placeholder:text-gray-300"
                  placeholder="Add note (e.g., No onion, extra cheese)"
                  value={l.note ?? ''}
                  onChange={(e) => setLineNote(l.id, e.target.value)}
                />
              </div>
            ))
          )}
        </div>
        <div className="border-t border-gray-700 mt-3 pt-3 space-y-1 text-sm">
          <div className="mb-3">
            <label className="block text-xs mb-1 opacity-70">Order note</label>
            <textarea
              className="w-full bg-gray-700 rounded px-2 py-2 text-sm"
              rows={2}
              placeholder="e.g., Allergies, delivery notes, table remarks"
              value={orderNote}
              onChange={(e) => setOrderNote(e.target.value)}
            />
          </div>
          <TicketTotals />
        </div>
        <div className="mt-3 flex gap-2">
          <button
            className="flex-1 bg-gray-600 hover:bg-gray-700 py-2 rounded disabled:opacity-60"
            disabled={lines.length === 0}
            onClick={() => {
              clear();
              setOrderNote('');
            }}
          >
            Clear
          </button>
          <button
            className="flex-1 bg-blue-600 hover:bg-blue-700 py-2 rounded disabled:opacity-60"
            disabled={lines.length === 0}
            onClick={async () => {
              if (!selectedTable) {
                setPendingAction('send');
                navigate('/app/tables');
                return;
              }
              // Ask for covers only if table is not marked as open (green)
              if (!isOpen(selectedTable.area, selectedTable.label)) {
                setCoversValue('');
                setShowCovers(true);
                return;
              }
              // Enrich log with details (table, order lines, notes, covers)
              const lastCovers = await window.api.covers.getLast(selectedTable.area, selectedTable.label);
              const details = {
                table: selectedTable.label,
                area: selectedTable.area,
                covers: lastCovers ?? null,
                orderNote,
                lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, note: l.note })),
              };
              console.log('ticket sent', details);
              await window.api.settings.testPrint();
              setOpen(selectedTable.area, selectedTable.label, true);
            }}
          >
            Send Items
          </button>
          <button
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded disabled:opacity-60"
            disabled={lines.length === 0}
            onClick={() => {
              if (!selectedTable) {
                setPendingAction('pay');
                navigate('/app/tables');
                return;
              }
              console.log(`ticket - ${selectedTable.label} paid`);
              setOpen(selectedTable.area, selectedTable.label, false);
            }}
          >
            Pay (F9)
          </button>
        </div>
      </div>
      {showCovers && selectedTable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">Covers for {selectedTable.label}</h3>
            <input
              autoFocus
              type="number"
              min={1}
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={coversValue}
              onChange={(e) => setCoversValue(e.target.value)}
            />
            <div className="flex gap-2 mt-4">
              <button className="flex-1 bg-gray-600 py-2 rounded" onClick={() => setShowCovers(false)}>Cancel</button>
              <button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded"
                onClick={async () => {
                  const num = Number(coversValue);
                  if (!Number.isFinite(num) || num <= 0) return;
                  await window.api.covers.save(selectedTable.area, selectedTable.label, num);
                  setOpen(selectedTable.area, selectedTable.label, true);
                  setShowCovers(false);
                  const details = {
                    table: selectedTable.label,
                    area: selectedTable.area,
                    covers: num,
                    orderNote,
                    lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, note: l.note })),
                  };
                  console.log('ticket sent', details);
                  await window.api.settings.testPrint();
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TicketTotals() {
  const { lines } = useTicketStore();
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const vat = lines.reduce((s, l) => s + l.unitPrice * l.qty * l.vatRate, 0);
  const total = subtotal + vat;
  return (
    <>
      <div className="flex justify-between"><span>Subtotal</span><span>  {subtotal.toFixed(2)}</span></div>
      <div className="flex justify-between"><span>VAT</span><span>  {vat.toFixed(2)}</span></div>
      <div className="flex justify-between font-semibold"><span>Total</span><span>  {total.toFixed(2)}</span></div>
    </>
  );
}


