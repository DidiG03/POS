import { useEffect, useMemo, useState } from 'react';

type MenuItem = {
  id: number;
  name: string;
  sku: string;
  price: number;
  vatRate: number;
  active: boolean;
  categoryId: number;
  isKg?: boolean;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
};

type MenuCategory = {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  color?: string | null;
  items: MenuItem[];
};

const CATEGORY_PRESETS = [
  'Drinks',
  'Food',
  'Desserts',
  'Starters',
  'Mains',
  'Sides',
  'Salads',
  'Breakfast',
  'Hot Drinks',
  'Soft Drinks',
  'Alcohol',
] as const;

export default function AdminMenuPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [cats, setCats] = useState<MenuCategory[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [billingPaused, setBillingPaused] = useState(false);

  const selected = useMemo(() => cats.find((c) => c.id === selectedId) || null, [cats, selectedId]);

  async function reload() {
    setErr(null);
    setLoading(true);
    try {
      const data = await window.api.menu.listCategoriesWithItems();
      setCats(data as any);
      if (data?.length && selectedId == null) setSelectedId(data[0].id);
      if (selectedId != null && !data?.some((c: any) => c.id === selectedId)) setSelectedId(data?.[0]?.id ?? null);
    } catch (e: any) {
      setErr(e?.message || 'Failed to load menu');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const b = await (window.api as any).billing?.getStatus?.();
        const enabled = Boolean((b as any)?.billingEnabled);
        const st = String((b as any)?.status || 'ACTIVE').toUpperCase();
        setBillingPaused(enabled && (st === 'PAST_DUE' || st === 'PAUSED'));
      } catch {
        setBillingPaused(false);
      }
    })();
  }, []);

  const [newCatName, setNewCatName] = useState<(typeof CATEGORY_PRESETS)[number] | ''>('');
  const [newCatColor, setNewCatColor] = useState<string>('#22c55e');

  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState<string>('');
  const [newItemVat, setNewItemVat] = useState<string>('0.2');
  const [newItemIsKg, setNewItemIsKg] = useState(false);
  const [newItemStation, setNewItemStation] = useState<'KITCHEN' | 'BAR' | 'DESSERT'>('KITCHEN');

  async function withSaving<T>(label: string, fn: () => Promise<T>) {
    setSaving(label);
    setErr(null);
    try {
      return await fn();
    } catch (e: any) {
      setErr(e?.message || 'Action failed');
      throw e;
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <div className="opacity-70">Loading menu…</div>;

  return (
    <div className="grid grid-cols-12 gap-4 min-h-[70vh]">
      <div className="col-span-4 bg-gray-800 rounded border border-gray-700 overflow-hidden">
        <div className="p-3 border-b border-gray-700 flex items-center justify-between">
          <div className="font-semibold">Categories</div>
          <button className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600" onClick={() => void reload()}>
            Refresh
          </button>
        </div>
        <div className="p-3 space-y-2">
          <div className="flex gap-2">
            <select
              className="bg-gray-700 rounded px-2 py-1 flex-1"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value as any)}
              title="Category preset"
            >
              <option value="">Select category…</option>
              {CATEGORY_PRESETS.map((n) => {
                const taken = cats.some((c) => c.name.trim().toLowerCase() === n.toLowerCase());
                return (
                  <option key={n} value={n} disabled={taken}>
                    {n}{taken ? ' (already exists)' : ''}
                  </option>
                );
              })}
            </select>
            <input
              type="color"
              className="w-10 h-9 rounded bg-gray-700"
              value={newCatColor}
              onChange={(e) => setNewCatColor(e.target.value)}
              title="Category color"
            />
            <button
              className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60"
              disabled={!newCatName || saving != null || billingPaused}
              onClick={() =>
                void withSaving('create-category', async () => {
                  const resp = await window.api.menu.createCategory({ name: String(newCatName), color: newCatColor } as any);
                  setNewCatName('');
                  await reload();
                  const createdId = Number((resp as any)?.id || 0);
                  if (createdId) setSelectedId(createdId);
                })
              }
            >
              Add
            </button>
          </div>

          <div className="divide-y divide-gray-700 border border-gray-700 rounded overflow-hidden">
            {cats.length === 0 && <div className="p-3 text-sm opacity-70">No categories yet.</div>}
            {cats.map((c) => (
              <button
                key={c.id}
                className={`w-full text-left p-3 hover:bg-gray-700 ${selectedId === c.id ? 'bg-gray-700' : ''}`}
                onClick={() => setSelectedId(c.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: c.color || '#374151' }} />
                    <span className="font-medium">{c.name}</span>
                  </div>
                  <span className="text-xs opacity-70">{c.items?.length || 0} items</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="col-span-8 bg-gray-800 rounded border border-gray-700 overflow-hidden">
        <div className="p-3 border-b border-gray-700 flex items-center justify-between">
          <div className="font-semibold">{selected ? `Category: ${selected.name}` : 'Select a category'}</div>
          {saving && <div className="text-xs opacity-70">Saving…</div>}
        </div>

        <div className="p-4 space-y-4">
          {err && <div className="p-3 rounded bg-rose-900/30 border border-rose-700 text-rose-200 text-sm">{err}</div>}
          {billingPaused && (
            <div className="p-3 rounded bg-amber-900/20 border border-amber-800 text-amber-200 text-sm">
              Billing is paused. You can view your menu, but adding or editing menu items is disabled until payment is completed.
            </div>
          )}

          {!selected ? (
            <div className="opacity-70">Pick a category on the left.</div>
          ) : (
            <>
              <CategoryEditor
                category={selected}
                allCategories={cats}
                disabled={saving != null || billingPaused}
                onSave={(patch) =>
                  withSaving('update-category', async () => {
                    await window.api.menu.updateCategory({ id: selected.id, ...patch } as any);
                    await reload();
                  })
                }
                onDelete={() =>
                  withSaving('delete-category', async () => {
                    await window.api.menu.deleteCategory(selected.id);
                    await reload();
                  })
                }
              />

              <div className="border-t border-gray-700 pt-4">
                <div className="font-semibold mb-2">Items</div>

                <div className="grid grid-cols-12 gap-2 mb-3">
                  <input
                    className="col-span-4 bg-gray-700 rounded px-2 py-2"
                    placeholder="Item name"
                    value={newItemName}
                    onChange={(e) => setNewItemName(e.target.value)}
                  />
                  <select
                    className="col-span-2 bg-gray-700 rounded px-2 py-2"
                    value={newItemStation}
                    onChange={(e) => setNewItemStation(e.target.value as any)}
                    title="Station"
                  >
                    <option value="KITCHEN">Kitchen</option>
                    <option value="BAR">Bar</option>
                    <option value="DESSERT">Dessert</option>
                  </select>
                  <input
                    className="col-span-2 bg-gray-700 rounded px-2 py-2"
                    placeholder="Price"
                    inputMode="decimal"
                    value={newItemPrice}
                    onChange={(e) => setNewItemPrice(e.target.value.replace(/[^0-9.]/g, ''))}
                  />
                  <input
                    className="col-span-2 bg-gray-700 rounded px-2 py-2"
                    placeholder="VAT (0.2)"
                    inputMode="decimal"
                    value={newItemVat}
                    onChange={(e) => setNewItemVat(e.target.value.replace(/[^0-9.]/g, ''))}
                  />
                  <label className="col-span-1 flex items-center gap-2 text-sm opacity-90">
                    <input type="checkbox" checked={newItemIsKg} onChange={(e) => setNewItemIsKg(e.target.checked)} />
                    Sold by kg
                  </label>
                  <button
                    className="col-span-1 bg-emerald-700 hover:bg-emerald-800 rounded px-2 py-2 disabled:opacity-60"
                    disabled={!newItemName.trim() || !newItemPrice || saving != null || billingPaused}
                    onClick={() =>
                      void withSaving('create-item', async () => {
                        const price = Number(newItemPrice);
                        const vatRate = newItemVat ? Number(newItemVat) : undefined;
                        await window.api.menu.createItem({
                          categoryId: selected.id,
                          name: newItemName.trim(),
                          price,
                          vatRate,
                          isKg: newItemIsKg,
                          station: newItemStation,
                          active: true,
                        } as any);
                        setNewItemName('');
                        setNewItemPrice('');
                        setNewItemIsKg(false);
                        setNewItemStation('KITCHEN');
                        await reload();
                      })
                    }
                  >
                    +
                  </button>
                </div>

                {selected.items.length === 0 ? (
                  <div className="opacity-70 text-sm">No items yet.</div>
                ) : (
                  <div className="divide-y divide-gray-700 border border-gray-700 rounded overflow-hidden">
                    {selected.items.map((it) => (
                      <ItemRow
                        key={it.id}
                        item={it}
                        disabled={saving != null}
                        onSave={(patch) =>
                          withSaving('update-item', async () => {
                            await window.api.menu.updateItem({ id: it.id, ...patch } as any);
                            await reload();
                          })
                        }
                        onDelete={() =>
                          withSaving('delete-item', async () => {
                            await window.api.menu.deleteItem(it.id);
                            await reload();
                          })
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryEditor({
  category,
  allCategories,
  disabled,
  onSave,
  onDelete,
}: {
  category: MenuCategory;
  allCategories: MenuCategory[];
  disabled: boolean;
  onSave: (patch: { name?: string; sortOrder?: number; color?: string | null; active?: boolean }) => Promise<any>;
  onDelete: () => Promise<any>;
}) {
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState<string>(String(category.color || '#374151'));
  const [colorText, setColorText] = useState<string>(String(category.color || '#374151'));
  const [sortOrder, setSortOrder] = useState(String(category.sortOrder ?? 0));

  useEffect(() => {
    setName(category.name);
    const next = String(category.color || '#374151');
    setColor(next);
    setColorText(next);
    setSortOrder(String(category.sortOrder ?? 0));
  }, [category.id, category.name, category.sortOrder, category.color]);

  function normalizeColorInput(v: string): string | null {
    const raw = String(v || '').trim();
    if (!raw) return null;
    const up = raw.startsWith('#') ? raw.toUpperCase() : `#${raw.toUpperCase()}`;
    if (/^#[0-9A-F]{6}$/.test(up)) return up;
    return null;
  }

  return (
    <div className="p-3 rounded border border-gray-700 bg-gray-800/40">
      <div className="grid grid-cols-12 gap-2 items-center">
        <div className="col-span-6">
          <div className="text-xs opacity-70 mb-1">Name</div>
          <select className="bg-gray-700 rounded px-2 py-2 w-full" value={name} onChange={(e) => setName(e.target.value)}>
            {/* If this category is legacy/custom, keep it selectable so we don't break existing data */}
            {!CATEGORY_PRESETS.some((p) => p.toLowerCase() === String(category.name || '').toLowerCase()) && (
              <option value={category.name}>{`Legacy: ${category.name}`}</option>
            )}
            {CATEGORY_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-3">
          <div className="text-xs opacity-70 mb-1">Color</div>
          <div className="flex gap-2 items-center">
            <input
              type="color"
              className="w-12 h-10 rounded bg-gray-700"
              value={color}
              onChange={(e) => {
                setColor(e.target.value);
                setColorText(e.target.value);
              }}
              title="Pick color"
            />
            <input
              className="bg-gray-700 rounded px-2 py-2 flex-1"
              placeholder="#RRGGBB"
              value={colorText}
              onChange={(e) => setColorText(e.target.value)}
              onBlur={() => {
                const norm = normalizeColorInput(colorText);
                if (norm) {
                  setColor(norm);
                  setColorText(norm);
                }
              }}
            />
            <button
              className="px-2 py-2 rounded bg-gray-700 hover:bg-gray-600 text-xs"
              disabled={disabled}
              onClick={() => {
                setColor('#374151');
                setColorText('');
              }}
              title="Clear color"
            >
              Clear
            </button>
          </div>
        </div>
        <div className="col-span-2">
          <div className="text-xs opacity-70 mb-1">Sort</div>
          <input
            className="bg-gray-700 rounded px-2 py-2 w-full"
            inputMode="numeric"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        <div className="col-span-2 flex gap-2 justify-end">
          <button
            className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
            disabled={disabled}
            onClick={() => {
              const norm = normalizeColorInput(colorText) ?? (color ? String(color) : null);
              const nextName = name.trim();
              const preset = CATEGORY_PRESETS.find((p) => p.toLowerCase() === nextName.toLowerCase());
              if (preset) {
                const takenByOther = allCategories.some(
                  (c) => Number(c.id) !== Number(category.id) && String(c.name || '').toLowerCase() === preset.toLowerCase()
                );
                if (takenByOther) return;
              }
              onSave({ name: name.trim(), color: norm, sortOrder: Number(sortOrder || 0) });
            }}
          >
            Save
          </button>
          <button className="px-3 py-2 rounded bg-red-700 hover:bg-red-800 disabled:opacity-60" disabled={disabled} onClick={() => onDelete()}>
            Delete
          </button>
        </div>
      </div>
      <div className="text-xs opacity-60 mt-2">Deleting a category will also hide its items (soft delete).</div>
    </div>
  );
}

function ItemRow({
  item,
  disabled,
  onSave,
  onDelete,
}: {
  item: MenuItem;
  disabled: boolean;
  onSave: (patch: { name?: string; price?: number; vatRate?: number; isKg?: boolean; station?: 'KITCHEN' | 'BAR' | 'DESSERT'; active?: boolean }) => Promise<any>;
  onDelete: () => Promise<any>;
}) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(String(item.price));
  const [vat, setVat] = useState(String(item.vatRate ?? 0.2));
  const [isKg, setIsKg] = useState(Boolean(item.isKg));
  const [station, setStation] = useState<'KITCHEN' | 'BAR' | 'DESSERT'>((item.station as any) || 'KITCHEN');
  const [active, setActive] = useState(Boolean(item.active));

  useEffect(() => {
    setName(item.name);
    setPrice(String(item.price));
    setVat(String(item.vatRate ?? 0.2));
    setIsKg(Boolean(item.isKg));
    setStation((item.station as any) || 'KITCHEN');
    setActive(Boolean(item.active));
  }, [item.id]);

  return (
    <div
      className={`p-3 grid grid-cols-12 gap-2 items-center ${active ? '' : 'opacity-60 bg-gray-900/20'}`}
      title={active ? undefined : 'Disabled: hidden from waiter menu'}
    >
      <div className="col-span-4">
        <input
          className={`bg-gray-700 rounded px-2 py-2 w-full ${active ? '' : 'line-through text-gray-300'}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex items-center justify-between gap-2 mt-1">
          <div className="text-[10px] opacity-60">SKU: {item.sku}</div>
          <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px]" value={station} onChange={(e) => setStation(e.target.value as any)}>
            <option value="KITCHEN">Kitchen</option>
            <option value="BAR">Bar</option>
            <option value="DESSERT">Dessert</option>
          </select>
        </div>
      </div>
      <input
        className="col-span-2 bg-gray-700 rounded px-2 py-2"
        inputMode="decimal"
        value={price}
        onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
      />
      <input
        className="col-span-2 bg-gray-700 rounded px-2 py-2"
        inputMode="decimal"
        value={vat}
        onChange={(e) => setVat(e.target.value.replace(/[^0-9.]/g, ''))}
      />
      <label className="col-span-1 flex items-center gap-2 text-xs opacity-90" title="Sold by kg">
        <input type="checkbox" checked={isKg} onChange={(e) => setIsKg(e.target.checked)} />
        <span>kg</span>
      </label>
      <label className="col-span-1 flex items-center gap-2 text-xs opacity-90" title="Show in waiter menu">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => {
            const next = e.target.checked;
            setActive(next);
            // Save immediately so disabling takes effect right away on waiter side
            onSave({ active: next });
          }}
          disabled={disabled}
        />
        <span className={active ? '' : 'text-rose-200'}>{active ? 'Enabled' : 'Disabled'}</span>
      </label>
      <div className="col-span-2 flex gap-2 justify-end">
        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
          disabled={disabled}
          onClick={() => onSave({ name: name.trim(), price: Number(price || 0), vatRate: Number(vat || 0), isKg, station, active })}
        >
          Save
        </button>
        <button className="px-3 py-2 rounded bg-red-700 hover:bg-red-800 disabled:opacity-60" disabled={disabled} onClick={() => onDelete()}>
          X
        </button>
      </div>
    </div>
  );
}

