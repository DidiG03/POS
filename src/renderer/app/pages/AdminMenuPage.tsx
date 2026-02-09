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

function IconRefresh() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M20 4v6h-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconX() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M12 20h9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M3 6h18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M8 6V4h8v2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 6l1 16h10l1-16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M10 11v6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M14 11v6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close modal"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-2xl rounded-2xl border border-gray-700/80 bg-gradient-to-b from-gray-900 to-gray-950 text-gray-100 shadow-2xl overflow-hidden"
      >
        <div className="px-4 sm:px-5 py-3.5 border-b border-gray-700/70 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold truncate">{title}</div>
            <div className="text-xs opacity-70 mt-0.5">
              Update details, then save changes.
            </div>
          </div>
          <button
            type="button"
            className="w-9 h-9 rounded-lg bg-gray-800/80 hover:bg-gray-700 border border-gray-700/80 flex items-center justify-center"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <IconX />
          </button>
        </div>
        <div className="p-4 sm:p-5">
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4 sm:p-5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminMenuPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [cats, setCats] = useState<MenuCategory[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [billingPaused, setBillingPaused] = useState(false);
  const [editCategoryId, setEditCategoryId] = useState<number | null>(null);

  const selected = useMemo(
    () => cats.find((c) => c.id === selectedId) || null,
    [cats, selectedId],
  );
  const editCategory = useMemo(
    () =>
      editCategoryId == null
        ? null
        : cats.find((c) => c.id === editCategoryId) || null,
    [cats, editCategoryId],
  );

  async function reload() {
    setErr(null);
    setLoading(true);
    try {
      const data = await window.api.menu.listCategoriesWithItems();
      setCats(data as any);
      if (data?.length && selectedId == null) setSelectedId(data[0].id);
      if (selectedId != null && !data?.some((c: any) => c.id === selectedId))
        setSelectedId(data?.[0]?.id ?? null);
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
    // Close the modal if the category was removed during reload/delete
    if (editCategoryId != null && !cats.some((c) => c.id === editCategoryId))
      setEditCategoryId(null);
  }, [cats, editCategoryId]);

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

  const [newCatName, setNewCatName] = useState<
    (typeof CATEGORY_PRESETS)[number] | ''
  >('');
  const [newCatColor, setNewCatColor] = useState<string>('#22c55e');

  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState<string>('');
  const [newItemVat, setNewItemVat] = useState<string>('0.2');
  const [newItemIsKg, setNewItemIsKg] = useState(false);
  const [newItemStation, setNewItemStation] = useState<
    'KITCHEN' | 'BAR' | 'DESSERT'
  >('KITCHEN');

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

  if (loading)
    return (
      <div className="w-full h-full min-h-[60vh] flex items-center justify-center">
        <div className="w-full max-w-md bg-gray-800 border border-gray-700 rounded p-6 text-gray-100">
          <div className="text-lg font-semibold mb-2">
            Connecting to POS backend…
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <div className="text-xs opacity-70">Loading menu…</div>
          </div>
        </div>
      </div>
    );

  return (
    <>
      <div className="h-full min-h-0 grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-4 bg-gray-800 rounded border border-gray-700 overflow-hidden min-h-0 flex flex-col">
          <div className="p-4 border-b border-gray-700 flex items-center justify-between">
            <div className="font-semibold">Categories</div>
            <button
              className="text-sm px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 flex items-center gap-2"
              onClick={() => void reload()}
              type="button"
              title="Refresh"
            >
              <IconRefresh />
              Refresh
            </button>
          </div>
          <div className="p-4 border-b border-gray-700">
            <div className="text-xs opacity-70 mb-2">Add category</div>
            <div className="flex gap-2">
              <select
                className="bg-gray-700 rounded px-3 py-2 flex-1"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value as any)}
                title="Category preset"
                disabled={saving != null || billingPaused}
              >
                <option value="">Select category…</option>
                {CATEGORY_PRESETS.map((n) => {
                  const taken = cats.some(
                    (c) => c.name.trim().toLowerCase() === n.toLowerCase(),
                  );
                  return (
                    <option key={n} value={n} disabled={taken}>
                      {n}
                      {taken ? ' (already exists)' : ''}
                    </option>
                  );
                })}
              </select>
              <input
                type="color"
                className="w-12 h-10 rounded bg-gray-700 border border-gray-600"
                value={newCatColor}
                onChange={(e) => setNewCatColor(e.target.value)}
                title="Category color"
                disabled={saving != null || billingPaused}
              />
              <button
                className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60"
                disabled={!newCatName || saving != null || billingPaused}
                onClick={() =>
                  void withSaving('create-category', async () => {
                    const resp = await window.api.menu.createCategory({
                      name: String(newCatName),
                      color: newCatColor,
                    } as any);
                    setNewCatName('');
                    await reload();
                    const createdId = Number((resp as any)?.id || 0);
                    if (createdId) setSelectedId(createdId);
                  })
                }
                type="button"
              >
                Add
              </button>
            </div>
          </div>

          <div className="p-2 overflow-auto min-h-0">
            {cats.length === 0 ? (
              <div className="p-3 text-sm opacity-70">No categories yet.</div>
            ) : (
              <div className="space-y-1">
                {cats.map((c) => (
                  <button
                    key={c.id}
                    className={`w-full text-left px-3 py-2 rounded hover:bg-gray-700 ${selectedId === c.id ? 'bg-gray-700' : ''}`}
                    onClick={() => setSelectedId(c.id)}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="inline-block w-3 h-3 rounded"
                          style={{ backgroundColor: c.color || '#374151' }}
                        />
                        <span className="font-medium truncate">{c.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-900/40 border border-gray-700 opacity-90">
                          {c.items?.length || 0}
                        </span>
                        <button
                          type="button"
                          className="w-8 h-8 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center disabled:opacity-60"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setSelectedId(c.id);
                            setEditCategoryId(c.id);
                          }}
                          disabled={saving != null || billingPaused}
                          aria-label={`Edit category ${c.name}`}
                          title="Edit category"
                        >
                          <IconPencil />
                        </button>
                        <button
                          type="button"
                          className="w-8 h-8 rounded bg-rose-700 hover:bg-rose-800 border border-rose-600 flex items-center justify-center disabled:opacity-60"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void withSaving('delete-category', async () => {
                              const ok = window.confirm(
                                `Delete category "${c.name}"?\n\nThis will also hide its items (soft delete).`,
                              );
                              if (!ok) return;
                              await window.api.menu.deleteCategory(c.id);
                              await reload();
                            });
                          }}
                          disabled={saving != null || billingPaused}
                          aria-label={`Delete category ${c.name}`}
                          title="Delete category"
                        >
                          <IconTrash />
                        </button>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="md:col-span-8 bg-gray-800 rounded border border-gray-700 overflow-hidden min-h-0 flex flex-col">
          <div className="p-4 border-b border-gray-700 flex items-center justify-between">
            <div className="font-semibold truncate">
              {selected ? `Category: ${selected.name}` : 'Menu editor'}
            </div>
            {saving && <div className="text-xs opacity-70">Saving…</div>}
          </div>

          <div className="p-4 space-y-4 overflow-auto min-h-0">
            {err && (
              <div className="p-3 rounded bg-rose-900/30 border border-rose-700 text-rose-200 text-sm">
                {err}
              </div>
            )}
            {billingPaused && (
              <div className="p-3 rounded bg-amber-900/20 border border-amber-800 text-amber-200 text-sm">
                Billing is paused. You can view your menu, but adding or editing
                menu items is disabled until payment is completed.
              </div>
            )}

            {!selected ? (
              <div className="rounded border border-gray-700 bg-gray-900/30 p-6 text-sm opacity-80">
                Select a category on the left to edit its details and items.
              </div>
            ) : (
              <>
                <div className="rounded border border-gray-700 bg-gray-800/40 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="font-semibold">Items</div>
                    <div className="text-xs opacity-70">
                      {selected.items?.length || 0} items
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 mb-3">
                    <input
                      className="sm:col-span-4 bg-gray-700 rounded px-3 py-2"
                      placeholder="Item name"
                      value={newItemName}
                      onChange={(e) => setNewItemName(e.target.value)}
                      disabled={saving != null || billingPaused}
                    />
                    <select
                      className="sm:col-span-2 bg-gray-700 rounded px-3 py-2"
                      value={newItemStation}
                      onChange={(e) => setNewItemStation(e.target.value as any)}
                      title="Station"
                      disabled={saving != null || billingPaused}
                    >
                      <option value="KITCHEN">Kitchen</option>
                      <option value="BAR">Bar</option>
                      <option value="DESSERT">Dessert</option>
                    </select>
                    <input
                      className="sm:col-span-2 bg-gray-700 rounded px-3 py-2"
                      placeholder="Price"
                      inputMode="decimal"
                      value={newItemPrice}
                      onChange={(e) =>
                        setNewItemPrice(e.target.value.replace(/[^0-9.]/g, ''))
                      }
                      disabled={saving != null || billingPaused}
                    />
                    <input
                      className="sm:col-span-2 bg-gray-700 rounded px-3 py-2"
                      placeholder="VAT (0.2)"
                      inputMode="decimal"
                      value={newItemVat}
                      onChange={(e) =>
                        setNewItemVat(e.target.value.replace(/[^0-9.]/g, ''))
                      }
                      disabled={saving != null || billingPaused}
                    />
                    <label className="sm:col-span-1 flex items-center gap-2 text-sm opacity-90">
                      <input
                        type="checkbox"
                        checked={newItemIsKg}
                        onChange={(e) => setNewItemIsKg(e.target.checked)}
                        disabled={saving != null || billingPaused}
                      />
                      kg
                    </label>
                    <button
                      className="sm:col-span-1 bg-emerald-700 hover:bg-emerald-800 rounded px-3 py-2 disabled:opacity-60"
                      disabled={
                        !newItemName.trim() ||
                        !newItemPrice ||
                        saving != null ||
                        billingPaused
                      }
                      onClick={() =>
                        void withSaving('create-item', async () => {
                          const price = Number(newItemPrice);
                          const vatRate = newItemVat
                            ? Number(newItemVat)
                            : undefined;
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
                      type="button"
                    >
                      Add
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
                              await window.api.menu.updateItem({
                                id: it.id,
                                ...patch,
                              } as any);
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

      {editCategory && (
        <Modal
          title={`Edit category: ${editCategory.name}`}
          onClose={() => setEditCategoryId(null)}
        >
          <CategoryEditor
            category={editCategory}
            allCategories={cats}
            disabled={saving != null || billingPaused}
            showDelete={false}
            onSave={(patch) =>
              withSaving('update-category', async () => {
                await window.api.menu.updateCategory({
                  id: editCategory.id,
                  ...patch,
                } as any);
                await reload();
                setEditCategoryId(null);
              })
            }
            onDelete={async () => {}}
          />
        </Modal>
      )}
    </>
  );
}

function CategoryEditor({
  category,
  allCategories,
  disabled,
  onSave,
  onDelete,
  showDelete = true,
}: {
  category: MenuCategory;
  allCategories: MenuCategory[];
  disabled: boolean;
  onSave: (patch: {
    name?: string;
    sortOrder?: number;
    color?: string | null;
    active?: boolean;
  }) => Promise<any>;
  onDelete: () => Promise<any>;
  showDelete?: boolean;
}) {
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState<string>(
    String(category.color || '#374151'),
  );
  const [colorText, setColorText] = useState<string>(
    String(category.color || '#374151'),
  );
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
    const up = raw.startsWith('#')
      ? raw.toUpperCase()
      : `#${raw.toUpperCase()}`;
    if (/^#[0-9A-F]{6}$/.test(up)) return up;
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
        <div className="md:col-span-6">
          <div className="text-xs opacity-70 mb-1">Name</div>
          <select
            className="bg-gray-700 rounded px-3 py-2 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
          >
            {/* If this category is legacy/custom, keep it selectable so we don't break existing data */}
            {!CATEGORY_PRESETS.some(
              (p) =>
                p.toLowerCase() === String(category.name || '').toLowerCase(),
            ) && (
              <option
                value={category.name}
              >{`Legacy: ${category.name}`}</option>
            )}
            {CATEGORY_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-4">
          <div className="text-xs opacity-70 mb-1">Color</div>
          <div className="grid grid-cols-[3rem_1fr_auto] gap-2 items-center">
            <input
              type="color"
              className="w-12 h-10 rounded bg-gray-700 border border-gray-600"
              value={color}
              onChange={(e) => {
                setColor(e.target.value);
                setColorText(e.target.value);
              }}
              title="Pick color"
              disabled={disabled}
            />
            <input
              className="bg-gray-700 rounded px-3 py-2 flex-1 min-w-[140px] font-mono"
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
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-xs disabled:opacity-60 border border-gray-600/70"
              disabled={disabled}
              onClick={() => {
                setColor('#374151');
                setColorText('');
              }}
              title="Clear color"
              type="button"
            >
              Clear
            </button>
          </div>
        </div>
        <div className="md:col-span-2">
          <div className="text-xs opacity-70 mb-1">Sort</div>
          <input
            className="bg-gray-700 rounded px-3 py-2 w-full"
            inputMode="numeric"
            value={sortOrder}
            onChange={(e) =>
              setSortOrder(e.target.value.replace(/[^0-9]/g, ''))
            }
            disabled={disabled}
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:justify-end pt-2">
        <button
          className="w-full sm:w-auto px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 font-medium"
          disabled={disabled}
          onClick={() => {
            const norm =
              normalizeColorInput(colorText) ?? (color ? String(color) : null);
            const nextName = name.trim();
            const preset = CATEGORY_PRESETS.find(
              (p) => p.toLowerCase() === nextName.toLowerCase(),
            );
            if (preset) {
              const takenByOther = allCategories.some(
                (c) =>
                  Number(c.id) !== Number(category.id) &&
                  String(c.name || '').toLowerCase() === preset.toLowerCase(),
              );
              if (takenByOther) return;
            }
            onSave({
              name: name.trim(),
              color: norm,
              sortOrder: Number(sortOrder || 0),
            });
          }}
          type="button"
        >
          Save
        </button>
        {showDelete && (
          <button
            className="w-full sm:w-auto px-4 py-2 rounded-lg bg-rose-700 hover:bg-rose-800 disabled:opacity-60 flex items-center justify-center gap-2 font-medium"
            disabled={disabled}
            onClick={() => onDelete()}
            type="button"
          >
            <IconX />
            Delete
          </button>
        )}
      </div>
      <div className="text-xs opacity-60">
        Deleting a category will also hide its items (soft delete).
      </div>
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
  onSave: (patch: {
    name?: string;
    price?: number;
    vatRate?: number;
    isKg?: boolean;
    station?: 'KITCHEN' | 'BAR' | 'DESSERT';
    active?: boolean;
  }) => Promise<any>;
  onDelete: () => Promise<any>;
}) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(String(item.price));
  const [vat, setVat] = useState(String(item.vatRate ?? 0.2));
  const [isKg, setIsKg] = useState(Boolean(item.isKg));
  const [station, setStation] = useState<'KITCHEN' | 'BAR' | 'DESSERT'>(
    (item.station as any) || 'KITCHEN',
  );
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
      className={`p-3 grid grid-cols-1 sm:grid-cols-12 gap-2 items-center ${active ? '' : 'opacity-60 bg-gray-900/20'}`}
      title={active ? undefined : 'Disabled: hidden from waiter menu'}
    >
      <div className="sm:col-span-4">
        <input
          className={`bg-gray-700 rounded px-3 py-2 w-full ${active ? '' : 'line-through text-gray-300'}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
        />
        <div className="text-[10px] opacity-60 mt-1">SKU: {item.sku}</div>
      </div>
      <select
        className="sm:col-span-2 bg-gray-700 rounded px-3 py-2"
        value={station}
        onChange={(e) => setStation(e.target.value as any)}
        disabled={disabled}
        title="Station"
      >
        <option value="KITCHEN">Kitchen</option>
        <option value="BAR">Bar</option>
        <option value="DESSERT">Dessert</option>
      </select>
      <input
        className="sm:col-span-2 bg-gray-700 rounded px-3 py-2"
        inputMode="decimal"
        value={price}
        onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
        disabled={disabled}
      />
      <input
        className="sm:col-span-2 bg-gray-700 rounded px-3 py-2"
        inputMode="decimal"
        value={vat}
        onChange={(e) => setVat(e.target.value.replace(/[^0-9.]/g, ''))}
        disabled={disabled}
      />
      <label
        className="sm:col-span-1 flex items-center gap-2 text-xs opacity-90"
        title="Sold by kg"
      >
        <input
          type="checkbox"
          checked={isKg}
          onChange={(e) => setIsKg(e.target.checked)}
          disabled={disabled}
        />
        <span>kg</span>
      </label>
      <label
        className="sm:col-span-1 flex items-center gap-2 text-xs opacity-90"
        title="Show in waiter menu"
      >
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
        <span className={active ? '' : 'text-rose-200'}>
          {active ? 'Enabled' : 'Disabled'}
        </span>
      </label>
      <div className="sm:col-span-2 flex flex-col sm:flex-row gap-2 justify-end">
        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
          disabled={disabled}
          onClick={() =>
            onSave({
              name: name.trim(),
              price: Number(price || 0),
              vatRate: Number(vat || 0),
              isKg,
              station,
              active,
            })
          }
          type="button"
        >
          Save
        </button>
        <button
          className="w-10 h-10 rounded bg-rose-700 hover:bg-rose-800 disabled:opacity-60 flex items-center justify-center"
          disabled={disabled}
          onClick={() => onDelete()}
          type="button"
          aria-label="Delete item"
          title="Delete item"
        >
          <IconX />
        </button>
      </div>
    </div>
  );
}
