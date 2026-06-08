import { useEffect, useMemo, useRef, useState } from 'react';
import { type ParsedMenuRow, parseMenuWorkbook } from '../../utils/menuImport';
import {
  kdsCategoryLinkLabel,
  kdsStationLabel,
  type KdsStation,
} from '@shared/kdsStations';
import { PageSpinner } from '../../components/PageSpinner';
import {
  IconWarningTriangle,
  normalizeStock,
  type StockLevel,
} from '../../components/StockAvailabilityPanel';

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
  stockLevel?: 'OK' | 'LOW' | 'OUT';
  stockRemaining?: number | null;
};

type MenuCategory = {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  color?: string | null;
  kdsStation?: KdsStation | null;
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

const OTHER_CATEGORY = '__OTHER__' as const;

type NewCategorySelection =
  | (typeof CATEGORY_PRESETS)[number]
  | typeof OTHER_CATEGORY
  | '';

function guessDefaultKdsStation(name: string): KdsStation | null {
  const n = String(name || '')
    .trim()
    .toLowerCase();
  if (
    n === 'drinks' ||
    n === 'hot drinks' ||
    n === 'soft drinks' ||
    n === 'alcohol' ||
    n === 'beverages'
  ) {
    return 'BAR';
  }
  if (
    n === 'food' ||
    n === 'starters' ||
    n === 'mains' ||
    n === 'sides' ||
    n === 'salads' ||
    n === 'breakfast' ||
    n === 'desserts'
  ) {
    return 'KITCHEN';
  }
  return null;
}

function KdsStationSelect({
  value,
  onChange,
  disabled,
}: {
  value: KdsStation | '';
  onChange: (next: KdsStation | '') => void;
  disabled?: boolean;
}) {
  return (
    <select
      className="bg-gray-700 rounded px-3 py-2 w-full"
      value={value}
      onChange={(e) => onChange((e.target.value || '') as KdsStation | '')}
      disabled={disabled}
    >
      <option value="">Not on KDS</option>
      {(['KITCHEN', 'BAR', 'DESSERT'] as KdsStation[]).map((st) => (
        <option key={st} value={st}>
          {kdsStationLabel(st)}
        </option>
      ))}
    </select>
  );
}

function IconRefresh() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M20 4v6h-6"
        stroke="currentColor"
        strokeWidth="1.75"
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
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M12 16V4m0 0L8 8m4-4 4 4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
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
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M12 20h9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
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
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M3 6h18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M8 6V4h8v2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 6l1 16h10l1-16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M10 11v6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M14 11v6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
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
            {subtitle !== undefined ? (
              subtitle && (
                <div className="text-xs opacity-70 mt-0.5">{subtitle}</div>
              )
            ) : (
              <div className="text-xs opacity-70 mt-0.5">
                Update details, then save changes.
              </div>
            )}
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
  const [showImport, setShowImport] = useState(false);

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

  const [newCatName, setNewCatName] = useState<NewCategorySelection>('');
  const [newCatCustomName, setNewCatCustomName] = useState('');
  const [newCatColor, setNewCatColor] = useState<string>('#22c55e');
  const [newCatKdsStation, setNewCatKdsStation] = useState<KdsStation | ''>('');

  const resolvedNewCatName = useMemo(() => {
    if (newCatName === OTHER_CATEGORY) return newCatCustomName.trim();
    return String(newCatName || '').trim();
  }, [newCatName, newCatCustomName]);

  const newCatNameTaken = useMemo(() => {
    const n = resolvedNewCatName.toLowerCase();
    if (!n) return false;
    return cats.some((c) => c.name.trim().toLowerCase() === n);
  }, [resolvedNewCatName, cats]);

  const canAddCategory =
    resolvedNewCatName.length > 0 &&
    !newCatNameTaken &&
    saving == null &&
    !billingPaused;

  const [showAddItem, setShowAddItem] = useState(false);

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

  if (loading) return <PageSpinner message="Loading menu…" />;

  return (
    <>
      <div className="h-full min-h-0 grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-4 bg-gray-800 rounded border border-gray-700 overflow-hidden min-h-0 flex flex-col">
          <div className="p-4 border-b border-gray-700 flex items-center justify-between">
            <div className="font-semibold">Categories</div>
            <div className="flex items-center gap-1">
              <button
                className="text-sm px-3 py-2 rounded bg-transparent hover:bg-gray-700 flex items-center gap-2 cursor-pointer disabled:opacity-60"
                onClick={() => setShowImport(true)}
                type="button"
                title="Import menu from Excel/CSV"
                disabled={billingPaused}
              >
                <IconUpload />
                <span className="hidden lg:inline">Import</span>
              </button>
              <button
                className="text-sm px-3 py-2 rounded bg-transparent hover:bg-gray-700 flex items-center gap-2 cursor-pointer"
                onClick={() => void reload()}
                type="button"
                title="Refresh"
              >
                <IconRefresh />
              </button>
            </div>
          </div>
          <div className="p-4 border-b border-gray-700">
            <div className="text-xs opacity-70 mb-2">Add category</div>
            <div className="flex gap-2">
              <select
                className="bg-gray-700 rounded px-3 py-2 flex-1"
                value={newCatName}
                onChange={(e) => {
                  const next = e.target.value as NewCategorySelection;
                  setNewCatName(next);
                  if (next === OTHER_CATEGORY) {
                    setNewCatCustomName('');
                    setNewCatKdsStation('');
                  } else {
                    setNewCatCustomName('');
                    setNewCatKdsStation(guessDefaultKdsStation(next) ?? '');
                  }
                }}
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
                <option value={OTHER_CATEGORY}>Other…</option>
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
                className="px-4 py-2 rounded bg-transparent hover:bg-gray-700 disabled:opacity-60 cursor-pointer"
                disabled={!canAddCategory}
                onClick={() =>
                  void withSaving('create-category', async () => {
                    const resp = await window.api.menu.createCategory({
                      name: resolvedNewCatName,
                      color: newCatColor,
                      kdsStation: newCatKdsStation || null,
                    } as any);
                    setNewCatName('');
                    setNewCatCustomName('');
                    setNewCatKdsStation('');
                    await reload();
                    const createdId = Number((resp as any)?.id || 0);
                    if (createdId) setSelectedId(createdId);
                  })
                }
                type="button"
              >
                +
              </button>
            </div>
            {newCatName === OTHER_CATEGORY && (
              <div className="mt-2">
                <div className="text-xs opacity-70 mb-1">Category name</div>
                <input
                  className="bg-gray-700 rounded px-3 py-2 w-full"
                  placeholder="Enter category name…"
                  value={newCatCustomName}
                  onChange={(e) => {
                    const next = e.target.value;
                    setNewCatCustomName(next);
                    setNewCatKdsStation(guessDefaultKdsStation(next) ?? '');
                  }}
                  disabled={saving != null || billingPaused}
                />
                {newCatCustomName.trim() && newCatNameTaken ? (
                  <div className="text-xs text-rose-400 mt-1">
                    A category with this name already exists.
                  </div>
                ) : null}
              </div>
            )}
            <div className="mt-2">
              <div className="text-xs opacity-70 mb-1">KDS display</div>
              <KdsStationSelect
                value={newCatKdsStation}
                onChange={setNewCatKdsStation}
                disabled={saving != null || billingPaused}
              />
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
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-900/50 border border-gray-700 opacity-80 shrink-0">
                          {kdsCategoryLinkLabel(c.kdsStation ?? null)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-900/40 border border-gray-700 opacity-90">
                          {c.items?.length || 0}
                        </span>
                        <button
                          type="button"
                          className="w-8 h-8 rounded bg-transparent hover:bg-gray-700 flex items-center justify-center disabled:opacity-60 cursor-pointer"
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
                          className="w-8 h-8 cursor-pointer rounded bg-rose-700 hover:bg-rose-800 border border-rose-600 flex items-center justify-center disabled:opacity-60"
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
            <div className="mb-3">
              <button
                className="px-4 py-2 rounded bg-transparent hover:bg-gray-700 disabled:opacity-60 font-medium flex items-center gap-2 cursor-pointer"
                disabled={saving != null || billingPaused}
                onClick={() => setShowAddItem(true)}
                type="button"
              >
                <span className="text-lg leading-none">+</span>
              </button>
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

                  {selected.items.length === 0 ? (
                    <div className="opacity-70 text-sm">No items yet.</div>
                  ) : (
                    <div className="divide-y divide-gray-700 border border-gray-700 rounded overflow-hidden">
                      {selected.items.map((it) => (
                        <ItemRow
                          key={it.id}
                          item={it}
                          kdsStation={selected.kdsStation ?? null}
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

      {showAddItem && selected && (
        <Modal
          title={`Add item to ${selected.name}`}
          subtitle="Fill in the details for the new menu item."
          onClose={() => setShowAddItem(false)}
        >
          <AddItemForm
            disabled={saving != null || billingPaused}
            onAdd={(data) =>
              withSaving('create-item', async () => {
                await window.api.menu.createItem({
                  categoryId: selected.id,
                  ...data,
                  active: true,
                } as any);
                await reload();
                setShowAddItem(false);
              })
            }
          />
        </Modal>
      )}

      {showImport && (
        <MenuImportModal
          categories={cats}
          disabled={billingPaused}
          onClose={() => setShowImport(false)}
          onImported={reload}
        />
      )}
    </>
  );
}

type ImportPlanRow = ParsedMenuRow & {
  status: 'new' | 'update' | 'new-category';
  existingItemId?: number;
};

function buildImportPlan(
  rows: ParsedMenuRow[],
  categories: MenuCategory[],
): { plan: ImportPlanRow[]; newCategories: string[] } {
  const norm = (v: string) => v.trim().toLowerCase();
  const catByName = new Map<string, MenuCategory>();
  for (const c of categories) catByName.set(norm(c.name), c);
  const itemByKey = new Map<string, number>();
  for (const c of categories)
    for (const it of c.items) itemByKey.set(`${c.id}||${norm(it.name)}`, it.id);

  const newCategorySet = new Set<string>();
  const plan: ImportPlanRow[] = rows.map((r) => {
    const cat = catByName.get(norm(r.category));
    if (!cat) {
      newCategorySet.add(r.category);
      return { ...r, status: 'new-category' };
    }
    const existingItemId = itemByKey.get(`${cat.id}||${norm(r.name)}`);
    return existingItemId != null
      ? { ...r, status: 'update', existingItemId }
      : { ...r, status: 'new' };
  });
  return { plan, newCategories: Array.from(newCategorySet) };
}

function MenuImportModal({
  categories,
  disabled,
  onClose,
  onImported,
}: {
  categories: MenuCategory[];
  disabled: boolean;
  onClose: () => void;
  onImported: () => Promise<void> | void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedMenuRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [result, setResult] = useState<{
    createdCategories: number;
    created: number;
    updated: number;
    skipped: number;
  } | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !importing) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, importing]);

  const { plan, newCategories } = useMemo(
    () => buildImportPlan(rows, categories),
    [rows, categories],
  );

  const counts = useMemo(() => {
    let create = 0;
    let update = 0;
    for (const r of plan) {
      if (r.status === 'update') update++;
      else create++;
    }
    return { create, update };
  }, [plan]);

  async function handleFile(file: File) {
    setError(null);
    setResult(null);
    setRows([]);
    setWarnings([]);
    setFileName(file.name);
    setParsing(true);
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const parsed = parseMenuWorkbook(XLSX, buf);
      setRows(parsed.rows);
      setWarnings(parsed.warnings);
      if (!parsed.rows.length && !parsed.warnings.length) {
        setError('No menu rows were found in the file.');
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to read the file.');
    } finally {
      setParsing(false);
    }
  }

  async function downloadTemplate() {
    try {
      const XLSX = await import('xlsx');
      const data = [
        ['Category', 'Name', 'Price', 'VAT', 'Kg', 'Station'],
        ['Drinks', 'Espresso', 1.5, 20, 'No', 'BAR'],
        ['Drinks', 'Cappuccino', 2, 20, 'No', 'BAR'],
        ['Food', 'Margherita Pizza', 6.5, 20, 'No', 'KITCHEN'],
        ['Food', 'Prosciutto (per kg)', 18, 20, 'Yes', 'KITCHEN'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Menu');
      XLSX.writeFile(wb, 'menu-template.xlsx');
    } catch (e: any) {
      setError(e?.message || 'Failed to create template.');
    }
  }

  async function runImport() {
    if (!rows.length || importing) return;
    setImporting(true);
    setError(null);
    const normName = (v: string) => v.trim().toLowerCase();
    try {
      // Re-fetch the live menu so matching is accurate even after a previous
      // partial import — this keeps the import idempotent (no duplicates on a
      // retry; existing items get updated instead).
      const fresh = (await window.api.menu.listCategoriesWithItems()) as any[];
      const catIdByName = new Map<string, number>();
      for (const c of fresh) catIdByName.set(normName(c.name), c.id);
      const itemIdByKey = new Map<string, number>();
      for (const c of fresh)
        for (const it of c.items || [])
          itemIdByKey.set(`${c.id}||${normName(it.name)}`, it.id);

      let createdCategories = 0;
      const neededCats = Array.from(
        new Set(rows.map((r) => r.category).filter(Boolean)),
      );
      for (const catName of neededCats) {
        if (catIdByName.has(normName(catName))) continue;
        const resp = await window.api.menu.createCategory({
          name: catName,
          kdsStation: guessDefaultKdsStation(catName) ?? null,
        } as any);
        const id = Number((resp as any)?.id || 0);
        if (id) {
          catIdByName.set(normName(catName), id);
          createdCategories++;
        }
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      setProgress({ done: 0, total: rows.length });
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const catId = catIdByName.get(normName(r.category));
        const existingId = catId
          ? itemIdByKey.get(`${catId}||${normName(r.name)}`)
          : undefined;
        if (!catId) {
          skipped++;
        } else if (existingId != null) {
          if (updateExisting) {
            await window.api.menu.updateItem({
              id: existingId,
              price: r.price,
              ...(r.vatRate != null ? { vatRate: r.vatRate } : {}),
              ...(r.isKg != null ? { isKg: r.isKg } : {}),
              ...(r.station ? { station: r.station } : {}),
            } as any);
            updated++;
          } else {
            skipped++;
          }
        } else {
          const resp = await window.api.menu.createItem({
            categoryId: catId,
            name: r.name,
            price: r.price,
            active: true,
            ...(r.vatRate != null ? { vatRate: r.vatRate } : {}),
            ...(r.isKg != null ? { isKg: r.isKg } : {}),
            ...(r.station ? { station: r.station } : {}),
          } as any);
          // Track the new item so a duplicate row later in the same file
          // updates it rather than colliding.
          const newId = Number((resp as any)?.id || 0);
          if (newId) itemIdByKey.set(`${catId}||${normName(r.name)}`, newId);
          created++;
        }
        setProgress({ done: i + 1, total: rows.length });
      }

      setResult({ createdCategories, created, updated, skipped });
      await onImported();
    } catch (e: any) {
      setError(e?.message || 'Import failed.');
    } finally {
      setImporting(false);
    }
  }

  const fmtPrice = (n: number) =>
    Number.isInteger(n) ? String(n) : n.toFixed(2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={() => !importing && onClose()}
        aria-label="Close modal"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl border border-gray-700/80 bg-gradient-to-b from-gray-900 to-gray-950 text-gray-100 shadow-2xl overflow-hidden"
      >
        <div className="px-4 sm:px-5 py-3.5 border-b border-gray-700/70 flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="font-semibold truncate">Import menu from Excel</div>
            <div className="text-xs opacity-70 mt-0.5">
              Upload an .xlsx, .xls or .csv file. Columns are detected
              automatically (Name, Price, Category, VAT, Kg, Station).
            </div>
          </div>
          <button
            type="button"
            className="w-9 h-9 rounded-lg bg-gray-800/80 hover:bg-gray-700 border border-gray-700/80 flex items-center justify-center disabled:opacity-50"
            onClick={onClose}
            disabled={importing}
            aria-label="Close"
            title="Close"
          >
            <IconX />
          </button>
        </div>

        <div className="p-4 sm:p-5 overflow-auto min-h-0 space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="px-4 py-2 rounded bg-green-600 hover:bg-green-500 disabled:opacity-60 cursor-pointer flex items-center gap-2"
              onClick={() => fileInputRef.current?.click()}
              disabled={parsing || importing || disabled}
            >
              <IconUpload />
              {fileName ? 'Choose another file' : 'Choose file'}
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 cursor-pointer text-sm"
              onClick={() => void downloadTemplate()}
              disabled={importing}
            >
              Download template
            </button>
            {fileName ? (
              <span className="text-sm opacity-80 truncate">{fileName}</span>
            ) : null}
            {parsing ? (
              <span className="text-sm opacity-80">Parsing…</span>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-lg border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-sm text-rose-200">
              {error}
            </div>
          ) : null}

          {result ? (
            <div className="rounded-lg border border-emerald-700/60 bg-emerald-900/25 px-4 py-3 text-sm">
              <div className="font-semibold text-emerald-300 mb-1">
                Import complete
              </div>
              <ul className="space-y-0.5 opacity-90">
                <li>{result.createdCategories} categories created</li>
                <li>{result.created} items added</li>
                <li>{result.updated} items updated</li>
                {result.skipped ? <li>{result.skipped} skipped</li> : null}
              </ul>
            </div>
          ) : null}

          {warnings.length ? (
            <div className="rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-2 text-xs text-amber-200 space-y-1 max-h-32 overflow-auto">
              {warnings.map((w, i) => (
                <div key={i}>• {w}</div>
              ))}
            </div>
          ) : null}

          {plan.length && !result ? (
            <>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <div className="opacity-80">
                  <span className="font-semibold text-gray-100">
                    {plan.length}
                  </span>{' '}
                  rows · {counts.create} new · {counts.update} existing
                  {newCategories.length
                    ? ` · ${newCategories.length} new categories`
                    : ''}
                </div>
                <label className="flex items-center gap-2 ml-auto cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={updateExisting}
                    onChange={(e) => setUpdateExisting(e.target.checked)}
                    disabled={importing}
                  />
                  Update prices of existing items
                </label>
              </div>

              <div className="rounded-lg border border-gray-800 overflow-hidden">
                <div className="max-h-[42vh] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-gray-800 text-left text-xs uppercase tracking-wide opacity-80">
                      <tr>
                        <th className="px-3 py-2">Category</th>
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2 text-right">Price</th>
                        <th className="px-3 py-2 text-right">VAT</th>
                        <th className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.map((r, i) => (
                        <tr
                          key={i}
                          className="border-t border-gray-800/70 hover:bg-gray-800/40"
                        >
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {r.category}
                          </td>
                          <td className="px-3 py-1.5">
                            {r.name}
                            {r.isKg ? (
                              <span className="ml-1 text-[10px] opacity-60">
                                /kg
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmtPrice(r.price)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums opacity-80">
                            {r.vatRate != null
                              ? `${Math.round(r.vatRate * 100)}%`
                              : '—'}
                          </td>
                          <td className="px-3 py-1.5">
                            {r.status === 'update' ? (
                              <span className="text-amber-300">
                                {updateExisting ? 'Update' : 'Skip'}
                              </span>
                            ) : r.status === 'new-category' ? (
                              <span className="text-sky-300">
                                New + category
                              </span>
                            ) : (
                              <span className="text-emerald-300">New</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-gray-700/70 flex items-center justify-end gap-3 shrink-0">
          {importing ? (
            <span className="text-sm opacity-80 mr-auto">
              Importing {progress.done}/{progress.total}…
            </span>
          ) : null}
          <button
            type="button"
            className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 cursor-pointer disabled:opacity-60"
            onClick={onClose}
            disabled={importing}
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result ? (
            <button
              type="button"
              className="px-4 py-2 rounded bg-green-600 hover:bg-green-500 cursor-pointer disabled:opacity-60"
              onClick={() => void runImport()}
              disabled={!plan.length || importing || disabled}
            >
              {importing
                ? 'Importing…'
                : `Import ${plan.length} item${plan.length === 1 ? '' : 's'}`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AddItemForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (data: {
    name: string;
    price: number;
    vatRate?: number;
    isKg: boolean;
  }) => Promise<any>;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [vat, setVat] = useState('0.2');
  const [isKg, setIsKg] = useState(false);

  const canSubmit = name.trim().length > 0 && price.length > 0 && !disabled;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs opacity-70 mb-1">Item name</div>
        <input
          autoFocus
          className="bg-gray-700 rounded px-3 py-2 w-full"
          placeholder="e.g. Margherita Pizza"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit)
              onAdd({
                name: name.trim(),
                price: Number(price),
                vatRate: vat ? Number(vat) : undefined,
                isKg,
              });
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs opacity-70 mb-1">Price</div>
          <input
            className="bg-gray-700 rounded px-3 py-2 w-full"
            placeholder="0.00"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
            disabled={disabled}
          />
        </div>
        <div>
          <div className="text-xs opacity-70 mb-1">VAT rate</div>
          <input
            className="bg-gray-700 rounded px-3 py-2 w-full"
            placeholder="0.2"
            inputMode="decimal"
            value={vat}
            onChange={(e) => setVat(e.target.value.replace(/[^0-9.]/g, ''))}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="flex items-end pb-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isKg}
            onChange={(e) => setIsKg(e.target.checked)}
            disabled={disabled}
          />
          Sold by kg
        </label>
      </div>

      <div className="flex justify-end pt-2">
        <button
          className="w-full px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 font-medium cursor-pointer"
          disabled={!canSubmit}
          onClick={() =>
            onAdd({
              name: name.trim(),
              price: Number(price),
              vatRate: vat ? Number(vat) : undefined,
              isKg,
            })
          }
          type="button"
        >
          Add Item
        </button>
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
    kdsStation?: KdsStation | null;
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
  const [kdsStation, setKdsStation] = useState<KdsStation | ''>(
    (category.kdsStation as KdsStation | null) ?? '',
  );

  useEffect(() => {
    setName(category.name);
    const next = String(category.color || '#374151');
    setColor(next);
    setColorText(next);
    setSortOrder(String(category.sortOrder ?? 0));
    setKdsStation((category.kdsStation as KdsStation | null) ?? '');
  }, [
    category.id,
    category.name,
    category.sortOrder,
    category.color,
    category.kdsStation,
  ]);

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
          </div>
        </div>
        <div className="md:col-span-12">
          <div className="text-xs opacity-70 mb-1">KDS display</div>
          <KdsStationSelect
            value={kdsStation}
            onChange={setKdsStation}
            disabled={disabled}
          />
          <div className="text-[10px] opacity-50 mt-1">
            Items in this category only appear on the linked KDS screen.
          </div>
        </div>
        {/* <div className="md:col-span-2">
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
        </div> */}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:justify-end pt-2">
        <button
          className="w-full px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 font-medium"
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
              kdsStation: kdsStation || null,
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
  kdsStation,
  disabled,
  onSave,
  onDelete,
}: {
  item: MenuItem;
  kdsStation: KdsStation | null;
  disabled: boolean;
  onSave: (patch: {
    name?: string;
    price?: number;
    vatRate?: number;
    isKg?: boolean;
    active?: boolean;
    stockLevel?: StockLevel;
    stockRemaining?: number | null;
  }) => Promise<any>;
  onDelete: () => Promise<any>;
}) {
  const [editing, setEditing] = useState(false);
  const active = Boolean(item.active);
  const stock = normalizeStock(item.stockLevel);
  const stationLabel = kdsCategoryLinkLabel(kdsStation);

  return (
    <>
      <div
        className={`px-3 py-2.5 flex items-center gap-3 ${active ? '' : 'opacity-50 bg-gray-900/20'}`}
        title={active ? undefined : 'Disabled: hidden from waiter menu'}
      >
        <div className="flex-1 min-w-0">
          <div
            className={`font-medium truncate ${active ? '' : 'line-through text-gray-400'}`}
          >
            {item.name}
          </div>
          <div className="text-[10px] opacity-50 mt-0.5">
            {stationLabel} · VAT {item.vatRate} {item.isKg ? ' · kg' : ''} ·
            SKU: {item.sku}
          </div>
        </div>
        <div className="text-sm font-semibold tabular-nums whitespace-nowrap">
          {Number(item.price).toFixed(2)}
        </div>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${active ? 'bg-emerald-900/50 text-emerald-300' : 'bg-rose-900/50 text-rose-300'}`}
        >
          {active ? 'On' : 'Off'}
        </span>
        {stock === 'LOW' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-200 border border-amber-700/50 inline-flex items-center gap-0.5">
            <IconWarningTriangle className="w-3 h-3 text-amber-300" />
            Low
            {item.stockRemaining != null &&
            Number.isFinite(Number(item.stockRemaining)) ? (
              <span className="tabular-nums opacity-90">
                · {Math.max(0, Math.floor(Number(item.stockRemaining)))}
              </span>
            ) : null}
          </span>
        )}
        {stock === 'OUT' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-900/50 text-rose-200 border border-rose-800/60">
            Out
          </span>
        )}
        <button
          type="button"
          className="w-8 h-8 rounded bg-transparent hover:bg-gray-700 flex items-center justify-center disabled:opacity-60 cursor-pointer"
          disabled={disabled}
          onClick={() => setEditing(true)}
          aria-label={`Edit ${item.name}`}
          title="Edit item"
        >
          <IconPencil />
        </button>
        <button
          type="button"
          className="w-8 h-8 rounded bg-rose-700 hover:bg-rose-800 border border-rose-600 flex items-center justify-center disabled:opacity-60"
          disabled={disabled}
          onClick={() => onDelete()}
          aria-label={`Delete ${item.name}`}
          title="Delete item"
        >
          <IconTrash />
        </button>
      </div>

      {editing && (
        <EditItemModal
          item={item}
          disabled={disabled}
          onSave={async (patch) => {
            await onSave(patch);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

function EditItemModal({
  item,
  disabled,
  onSave,
  onClose,
}: {
  item: MenuItem;
  disabled: boolean;
  onSave: (patch: {
    name?: string;
    price?: number;
    vatRate?: number;
    isKg?: boolean;
    active?: boolean;
    stockLevel?: StockLevel;
    stockRemaining?: number | null;
  }) => Promise<any>;
  onClose: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(String(item.price));
  const [vat, setVat] = useState(String(item.vatRate ?? 0.2));
  const [isKg, setIsKg] = useState(Boolean(item.isKg));
  const [active, setActive] = useState(Boolean(item.active));
  const [stockLevel, setStockLevel] = useState<StockLevel>(
    normalizeStock(item.stockLevel),
  );
  const [stockQty, setStockQty] = useState(() =>
    item.stockRemaining != null && Number.isFinite(Number(item.stockRemaining))
      ? String(Math.max(1, Math.floor(Number(item.stockRemaining))))
      : '10',
  );

  useEffect(() => {
    setName(item.name);
    setPrice(String(item.price));
    setVat(String(item.vatRate ?? 0.2));
    setIsKg(Boolean(item.isKg));
    setActive(Boolean(item.active));
    setStockLevel(normalizeStock(item.stockLevel));
    setStockQty(
      item.stockRemaining != null &&
        Number.isFinite(Number(item.stockRemaining))
        ? String(Math.max(1, Math.floor(Number(item.stockRemaining))))
        : '10',
    );
  }, [
    item.id,
    item.name,
    item.price,
    item.vatRate,
    item.isKg,
    item.active,
    item.stockLevel,
    item.stockRemaining,
  ]);

  const stockQtyNum = parseInt(String(stockQty).trim(), 10);
  const stockQtyOk =
    stockLevel !== 'LOW' || (Number.isFinite(stockQtyNum) && stockQtyNum >= 1);

  const canSubmit =
    name.trim().length > 0 && price.length > 0 && !disabled && stockQtyOk;

  return (
    <Modal title={`Edit: ${item.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <div className="text-xs opacity-70 mb-1">Item name</div>
          <input
            autoFocus
            className="bg-gray-700 rounded px-3 py-2 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
          />
          <div className="text-[10px] opacity-50 mt-1">SKU: {item.sku}</div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs opacity-70 mb-1">Price</div>
            <input
              className="bg-gray-700 rounded px-3 py-2 w-full"
              placeholder="0.00"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
              disabled={disabled}
            />
          </div>
          <div>
            <div className="text-xs opacity-70 mb-1">VAT rate</div>
            <input
              className="bg-gray-700 rounded px-3 py-2 w-full"
              placeholder="0.2"
              inputMode="decimal"
              value={vat}
              onChange={(e) => setVat(e.target.value.replace(/[^0-9.]/g, ''))}
              disabled={disabled}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs opacity-70 mb-1">Waiter availability</div>
            <select
              className="bg-gray-700 rounded px-3 py-2 w-full"
              value={stockLevel}
              onChange={(e) => setStockLevel(e.target.value as StockLevel)}
              disabled={disabled}
            >
              <option value="OK">In stock</option>
              <option value="LOW">Low stock (warning)</option>
              <option value="OUT">Out of stock (unavailable)</option>
            </select>
          </div>
        </div>

        {stockLevel === 'LOW' && (
          <div>
            <div className="text-xs opacity-70 mb-1">How many left (today)</div>
            <input
              type="number"
              min={1}
              step={1}
              className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
              value={stockQty}
              onChange={(e) => setStockQty(e.target.value)}
              disabled={disabled}
            />
            <p className="text-[10px] opacity-55 mt-1">
              Each kitchen send reduces this count. At 0 the item becomes out of
              stock. Resets after midnight.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3 pb-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isKg}
              onChange={(e) => setIsKg(e.target.checked)}
              disabled={disabled}
            />
            Sold by kg
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              disabled={disabled}
            />
            <span className={active ? '' : 'text-rose-300'}>
              {active ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>

        <div className="flex justify-end pt-2">
          <button
            className="w-full px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 font-medium"
            disabled={!canSubmit}
            onClick={() => {
              const patch: {
                name: string;
                price: number;
                vatRate: number;
                isKg: boolean;
                active: boolean;
                stockLevel: StockLevel;
                stockRemaining?: number | null;
              } = {
                name: name.trim(),
                price: Number(price || 0),
                vatRate: Number(vat || 0),
                isKg,
                active,
                stockLevel,
              };
              if (stockLevel === 'LOW') {
                patch.stockRemaining = Math.max(
                  1,
                  Math.floor(stockQtyNum || 1),
                );
              }
              return onSave(patch);
            }}
            type="button"
          >
            Save Changes
          </button>
        </div>
      </div>
    </Modal>
  );
}
