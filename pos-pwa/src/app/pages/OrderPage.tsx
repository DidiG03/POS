import { useEffect, useMemo, useState } from 'react';
import { useTicketStore } from '../../stores/ticket';
import { useOrderContext } from '../../stores/orderContext';
import { useTableStatus } from '../../stores/tableStatus';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/session';
import { api } from '../../api';

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
  const { lines, addItem, increment, decrement, setLineNote, orderNote, setOrderNote, clear, removeLine } = useTicketStore();
  const { selectedTable, setPendingAction } = useOrderContext();
  const { setOpen, isOpen } = useTableStatus();
  const [showCovers, setShowCovers] = useState(false);
  const [coversValue, setCoversValue] = useState('');
  const [voidTarget, setVoidTarget] = useState<{
    id: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
    note?: string;
  } | null>(null);
  const navigate = useNavigate();
  const { user } = useSessionStore();

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
    const data = await api.menu.listCategoriesWithItems();
    setCategories(data);
    if (data.length && !selectedCatId) setSelectedCatId(data[0].id);
  };

  useEffect(() => {
    loadMenu();
  }, []);

  // If an open table's ticket becomes empty due to voids, free the table (turn green)
  useEffect(() => {
    if (!selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (lines.length === 0) {
      setOpen(selectedTable.area, selectedTable.label, false);
    }
  }, [lines.length, selectedTable]);


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
                    {/* When table is open (sent), disable hard remove; show Void instead */}
                    {selectedTable && isOpen(selectedTable.area, selectedTable.label) ? (
                      <button
                        className="px-2 bg-red-700 rounded text-xs"
                        onClick={() =>
                          setVoidTarget({
                            id: l.id,
                            name: l.name,
                            qty: l.qty,
                            unitPrice: l.unitPrice,
                            vatRate: l.vatRate,
                            note: l.note,
                          })
                        }
                      >
                        Void
                      </button>
                    ) : (
                      <button className="px-2 bg-gray-600 rounded text-xs" onClick={() => removeLine(l.id)}>Remove</button>
                    )}
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
            onClick={async () => {
              if (selectedTable && isOpen(selectedTable.area, selectedTable.label)) {
                if (!user?.id) return;
                await api.tickets.voidTicket({
                  userId: user.id,
                  area: selectedTable.area,
                  tableLabel: selectedTable.label,
                  reason: orderNote || undefined,
                });
                // Free table when fully voided
                setOpen(selectedTable.area, selectedTable.label, false);
              }
              clear();
              setOrderNote('');
            }}
          >
            {selectedTable && isOpen(selectedTable.area, selectedTable.label) ? 'Void Ticket' : 'Clear'}
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
              const lastCovers = await api.covers.getLast(selectedTable.area, selectedTable.label);
              const details = {
                table: selectedTable.label,
                area: selectedTable.area,
                covers: lastCovers ?? null,
                orderNote,
                lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, vatRate: l.vatRate, note: l.note })),
              };
              console.log('ticket sent', details);
              if (!user?.id) return; // require logged-in user to log ticket
              await api.tickets.log({
                userId: user.id,
                area: selectedTable.area,
                tableLabel: selectedTable.label,
                covers: lastCovers ?? null,
                items: details.lines,
                note: orderNote,
              });
              await api.settings.testPrint();
              setOpen(selectedTable.area, selectedTable.label, true);
              await api.tables.setOpen(selectedTable.area, selectedTable.label, true).catch(() => {});
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
              api.tables.setOpen(selectedTable.area, selectedTable.label, false).catch(() => {});
              clear();
              setOrderNote('');
            }}
          >
            Pay
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
                  await api.covers.save(selectedTable.area, selectedTable.label, num);
                  setOpen(selectedTable.area, selectedTable.label, true);
                  setShowCovers(false);
                  const details = {
                    table: selectedTable.label,
                    area: selectedTable.area,
                    covers: num,
                    orderNote,
                    lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, vatRate: l.vatRate, note: l.note })),
                  };
                  console.log('ticket sent', details);
                  if (!user?.id) return;
                  await api.tickets.log({
                    userId: user.id,
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    covers: num,
                    items: details.lines,
                    note: orderNote,
                  });
                  await api.settings.testPrint();
                  await api.tables.setOpen(selectedTable.area, selectedTable.label, true).catch(() => {});
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {voidTarget && selectedTable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">Void item?</h3>
            <p className="text-sm opacity-80 text-center mb-4">
              {voidTarget.name} ×{voidTarget.qty} on {selectedTable.area} • {selectedTable.label}
            </p>
            <div className="flex gap-2 mt-2">
              <button className="flex-1 bg-gray-600 py-2 rounded" onClick={() => setVoidTarget(null)}>Cancel</button>
              <button
                className="flex-1 bg-red-700 hover:bg-red-800 py-2 rounded"
                onClick={async () => {
                  if (!user?.id) return;
                  await api.tickets.voidItem({
                    userId: user.id,
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    item: {
                      name: voidTarget.name,
                      qty: voidTarget.qty,
                      unitPrice: voidTarget.unitPrice,
                      vatRate: voidTarget.vatRate,
                      note: voidTarget.note,
                    },
                  });
                  removeLine(voidTarget.id);
                  setVoidTarget(null);
                }}
              >
                Confirm Void
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


