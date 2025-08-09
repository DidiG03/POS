import { useEffect, useMemo, useState } from 'react';

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

  const selected = useMemo(
    () => categories.find((c) => c.id === selectedCatId) ?? categories[0],
    [categories, selectedCatId],
  );

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = selected ? selected.items : categories.flatMap((c) => c.items);
    if (!q) return source;
    return source.filter((i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q));
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
    <div className="grid grid-cols-3 gap-4">
      <div className="col-span-2">
        <div className="flex gap-2 mb-3">
          <input
            placeholder="Search menu (F2)"
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
              className={`py-3 rounded ${selected?.id === c.id ? 'bg-emerald-600' : 'bg-gray-700'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {filteredItems.map((i) => (
            <button key={i.id} className="bg-gray-700 py-4 rounded text-left px-3">
              <div className="font-medium">{i.name}</div>
              <div className="text-sm opacity-75">{i.sku}</div>
              <div className="text-sm">€ {i.price.toFixed(2)}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="bg-gray-800 p-3 rounded">
        <div className="font-semibold mb-2">Ticket</div>
        <div className="h-64 overflow-auto space-y-2">
          <div className="text-sm opacity-60">Select items to add…</div>
        </div>
        <div className="border-t border-gray-700 mt-3 pt-3 space-y-1 text-sm">
          <div className="flex justify-between"><span>Subtotal</span><span>0.00</span></div>
          <div className="flex justify-between"><span>VAT</span><span>0.00</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span>0.00</span></div>
        </div>
        <button className="mt-3 w-full bg-emerald-600 py-2 rounded">Pay (F9)</button>
      </div>
    </div>
  );
}


