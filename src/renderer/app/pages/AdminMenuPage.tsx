import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ParsedMenuRow, parseMenuWorkbook } from '../../utils/menuImport';
import { type KdsStation } from '@shared/kdsStations';
import { PageSpinner } from '../../components/PageSpinner';
import {
  IconWarningTriangle,
  normalizeStock,
  type StockLevel,
} from '../../components/StockAvailabilityPanel';
import { KebabMenu } from '../components/SettingsChrome';
import { Button, IconButton } from '../../components/ui/Button';
import { Field, Input, Select, Switch } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/Surface';
import { cn } from '../../components/ui/cn';

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

function kdsLinkLabel(
  t: (key: string) => string,
  station: KdsStation | null | undefined,
): string {
  if (!station) return t('adminMenu.notOnKds');
  return t(`kdsSettings.station${station}`);
}

function presetLabel(
  t: (key: string, opts?: { defaultValue?: string }) => string,
  name: string,
) {
  return t(`adminMenu.presets.${name.replace(/\s+/g, '')}`, {
    defaultValue: name,
  });
}

function vatPercent(rate: number): number {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? Math.round(n) : Math.round(n * 100);
}

function IconPlus() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
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
  const { t } = useTranslation();
  return (
    <Select
      value={value}
      onChange={(e) => onChange((e.target.value || '') as KdsStation | '')}
      disabled={disabled}
    >
      <option value="">{t('adminMenu.notOnKds')}</option>
      {(['KITCHEN', 'BAR', 'DESSERT'] as KdsStation[]).map((st) => (
        <option key={st} value={st}>
          {t(`kdsSettings.station${st}`)}
        </option>
      ))}
    </Select>
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
  const { t } = useTranslation();
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
        aria-label={t('common.close')}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-2xl overflow-hidden rounded-lg border border-white/10 bg-[var(--pos-surface)] text-gray-100 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/7 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">{title}</div>
            {subtitle !== undefined ? (
              subtitle && (
                <div className="mt-0.5 text-[12px] text-gray-500">
                  {subtitle}
                </div>
              )
            ) : (
              <div className="mt-0.5 text-[12px] text-gray-500">
                {t('adminMenu.modalHint')}
              </div>
            )}
          </div>
          <IconButton
            label={t('common.close')}
            icon={<IconX />}
            onClick={onClose}
          />
        </div>
        <div className="p-4 sm:p-5">
          <div className="rounded-lg border border-white/7 bg-[var(--pos-canvas)] p-4 sm:p-5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminMenuPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [cats, setCats] = useState<MenuCategory[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [billingPaused, setBillingPaused] = useState(false);
  const [editCategoryId, setEditCategoryId] = useState<number | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const initialLoad = useRef(true);

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
    if (initialLoad.current) setLoading(true);
    try {
      const data = await window.api.menu.listCategoriesWithItems();
      setCats(data as any);
      if (data?.length && selectedId == null) setSelectedId(data[0].id);
      if (selectedId != null && !data?.some((c: any) => c.id === selectedId))
        setSelectedId(data?.[0]?.id ?? null);
    } catch (e: any) {
      setErr(e?.message || t('adminMenu.loadFailed'));
    } finally {
      initialLoad.current = false;
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
      setErr(e?.message || t('adminMenu.actionFailed'));
      throw e;
    } finally {
      setSaving(null);
    }
  }

  const busy = saving != null || billingPaused;

  async function addCategory() {
    await withSaving('create-category', async () => {
      const resp = await window.api.menu.createCategory({
        name: resolvedNewCatName,
        color: newCatColor,
        kdsStation: newCatKdsStation || null,
      } as any);
      setNewCatName('');
      setNewCatCustomName('');
      setNewCatKdsStation('');
      setShowAddCategory(false);
      await reload();
      const createdId = Number((resp as any)?.id || 0);
      if (createdId) setSelectedId(createdId);
    });
  }

  if (loading) return <PageSpinner message={t('adminMenu.loading')} />;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-3 md:flex-row">
        <aside className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-lg border border-white/7 bg-[var(--pos-surface)] md:w-[340px]">
          <div className="flex items-center gap-2 border-b border-white/7 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-gray-100">
                {t('adminMenu.categories')}
              </div>
              {cats.length > 0 ? (
                <div className="text-[11px] text-gray-500">
                  {t('adminMenu.categoryCount', { count: cats.length })}
                </div>
              ) : null}
            </div>
            <IconButton
              label={t('adminMenu.addCategory')}
              icon={<IconPlus />}
              disabled={busy}
              onClick={() => setShowAddCategory((v) => !v)}
            />
            <IconButton
              label={t('common.refresh')}
              icon={<IconRefresh />}
              onClick={() => void reload()}
            />
            <KebabMenu
              label={t('common.moreActions')}
              disabled={billingPaused}
              items={[
                {
                  label: t('adminMenu.import'),
                  onSelect: () => setShowImport(true),
                  disabled: billingPaused,
                },
              ]}
            />
          </div>

          {showAddCategory ? (
            <div className="space-y-2 border-b border-white/7 px-3 py-3">
              <div className="flex items-center gap-2">
                <Select
                  className="flex-1"
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
                  title={t('adminMenu.addCategory')}
                  disabled={busy}
                >
                  <option value="">{t('adminMenu.selectCategory')}</option>
                  {CATEGORY_PRESETS.map((n) => {
                    const taken = cats.some(
                      (c) => c.name.trim().toLowerCase() === n.toLowerCase(),
                    );
                    return (
                      <option key={n} value={n} disabled={taken}>
                        {presetLabel(t, n)}
                        {taken ? ` ${t('adminMenu.alreadyExists')}` : ''}
                      </option>
                    );
                  })}
                  <option value={OTHER_CATEGORY}>{t('adminMenu.other')}</option>
                </Select>
                <input
                  type="color"
                  className="h-[var(--pos-control-h)] w-10 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
                  value={newCatColor}
                  onChange={(e) => setNewCatColor(e.target.value)}
                  title={t('adminMenu.categoryColor')}
                  disabled={busy}
                />
                <IconButton
                  label={t('common.add')}
                  icon={<IconPlus />}
                  variant="primary"
                  disabled={!canAddCategory}
                  onClick={() => void addCategory()}
                />
              </div>
              {newCatName === OTHER_CATEGORY ? (
                <Field
                  label={t('adminMenu.categoryName')}
                  error={
                    newCatCustomName.trim() && newCatNameTaken
                      ? t('adminMenu.nameTaken')
                      : undefined
                  }
                >
                  <Input
                    placeholder={t('adminMenu.categoryNamePlaceholder')}
                    value={newCatCustomName}
                    onChange={(e) => {
                      const next = e.target.value;
                      setNewCatCustomName(next);
                      setNewCatKdsStation(guessDefaultKdsStation(next) ?? '');
                    }}
                    disabled={busy}
                  />
                </Field>
              ) : null}
              {newCatName ? (
                <Field label={t('adminMenu.kdsDisplay')}>
                  <KdsStationSelect
                    value={newCatKdsStation}
                    onChange={setNewCatKdsStation}
                    disabled={busy}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {cats.length === 0 ? (
              <EmptyState
                compact
                title={t('adminMenu.noCategories')}
                description={t('adminMenu.noCategoriesHint')}
                action={
                  showAddCategory ? undefined : (
                    <Button
                      size="sm"
                      onClick={() => setShowAddCategory(true)}
                      disabled={busy}
                    >
                      {t('adminMenu.addCategory')}
                    </Button>
                  )
                }
              />
            ) : (
              <div className="space-y-0.5">
                {cats.map((c) => (
                  <div
                    key={c.id}
                    className={cn(
                      'pos-side-link w-full',
                      selectedId === c.id
                        ? 'pos-side-link--active'
                        : 'pos-side-link--idle',
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setSelectedId(c.id)}
                    >
                      <span
                        className="inline-block size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: c.color || '#374151' }}
                      />
                      <span className="min-w-0 truncate">{c.name}</span>
                      {c.kdsStation ? (
                        <Badge className="shrink-0 text-[10px]">
                          {kdsLinkLabel(t, c.kdsStation)}
                        </Badge>
                      ) : null}
                    </button>
                    <span className="shrink-0 text-[11px] tabular-nums text-gray-500">
                      {c.items?.length || 0}
                    </span>
                    <KebabMenu
                      label={t('common.moreActions')}
                      disabled={busy}
                      items={[
                        {
                          label: t('common.edit'),
                          onSelect: () => {
                            setSelectedId(c.id);
                            setEditCategoryId(c.id);
                          },
                          disabled: busy,
                        },
                        {
                          label: t('common.delete'),
                          danger: true,
                          disabled: busy,
                          onSelect: () =>
                            void withSaving('delete-category', async () => {
                              const ok = window.confirm(
                                t('adminMenu.deleteCategoryConfirm', {
                                  name: c.name,
                                }),
                              );
                              if (!ok) return;
                              await window.api.menu.deleteCategory(c.id);
                              await reload();
                            }),
                        },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/7 bg-[var(--pos-surface)]">
          <div className="flex items-center gap-2 border-b border-white/7 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-gray-100">
                {selected ? selected.name : t('adminMenu.menuEditor')}
              </div>
              {selected ? (
                <div className="text-[11px] text-gray-500">
                  {t('adminMenu.itemCount', {
                    count: selected.items?.length || 0,
                  })}
                </div>
              ) : null}
            </div>
            {saving ? (
              <span className="text-[11px] text-gray-500">
                {t('common.saving')}
              </span>
            ) : null}
            {selected ? (
              <Button
                size="sm"
                icon={<IconPlus />}
                disabled={busy}
                onClick={() => setShowAddItem(true)}
              >
                {t('adminMenu.addItem')}
              </Button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {err ? (
              <div className="m-3 rounded-lg border border-rose-700/60 bg-rose-900/25 px-3 py-2 text-[13px] text-rose-200">
                {err}
              </div>
            ) : null}
            {billingPaused ? (
              <div className="m-3 rounded-lg border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-[13px] text-amber-200">
                {t('adminMenu.billingPaused')}
              </div>
            ) : null}

            {!selected ? (
              <EmptyState
                title={t('adminMenu.menuEditor')}
                description={t('adminMenu.selectCategoryHint')}
              />
            ) : selected.items.length === 0 ? (
              <EmptyState
                title={t('adminMenu.noItems')}
                description={t('adminMenu.noItemsHint')}
                action={
                  <Button
                    size="sm"
                    icon={<IconPlus />}
                    disabled={busy}
                    onClick={() => setShowAddItem(true)}
                  >
                    {t('adminMenu.addItem')}
                  </Button>
                }
              />
            ) : (
              <div className="divide-y divide-white/6">
                {selected.items.map((it) => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    kdsStation={selected.kdsStation ?? null}
                    disabled={busy}
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
                        const ok = window.confirm(
                          t('adminMenu.deleteItemConfirm', { name: it.name }),
                        );
                        if (!ok) return;
                        await window.api.menu.deleteItem(it.id);
                        await reload();
                      })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {editCategory && (
        <Modal
          title={t('adminMenu.editCategory', { name: editCategory.name })}
          onClose={() => setEditCategoryId(null)}
        >
          <CategoryEditor
            category={editCategory}
            allCategories={cats}
            disabled={busy}
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
          title={t('adminMenu.addItemTo', { name: selected.name })}
          subtitle={t('adminMenu.addItemHint')}
          onClose={() => setShowAddItem(false)}
        >
          <AddItemForm
            disabled={busy}
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
  const { t } = useTranslation();
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
      setError(e?.message || t('adminMenu.parseFailed'));
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
      setError(e?.message || t('adminMenu.templateFailed'));
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
      setError(e?.message || t('adminMenu.importFailed'));
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
        aria-label={t('common.close')}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-white/10 bg-[var(--pos-surface)] text-gray-100 shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/7 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">
              {t('adminMenu.importMenu')}
            </div>
            <div className="mt-0.5 text-[12px] text-gray-500">
              {t('adminMenu.importHint')}
            </div>
          </div>
          <IconButton
            label={t('common.close')}
            icon={<IconX />}
            disabled={importing}
            onClick={onClose}
          />
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
            <Button
              icon={<IconUpload />}
              disabled={parsing || importing || disabled}
              onClick={() => fileInputRef.current?.click()}
            >
              {fileName
                ? t('adminMenu.chooseAnotherFile')
                : t('adminMenu.chooseFile')}
            </Button>
            <Button
              variant="secondary"
              disabled={importing}
              onClick={() => void downloadTemplate()}
            >
              {t('adminMenu.downloadTemplate')}
            </Button>
            {fileName ? (
              <span className="truncate text-[13px] text-gray-400">
                {fileName}
              </span>
            ) : null}
            {parsing ? (
              <span className="text-[13px] text-gray-400">
                {t('adminMenu.parsing')}
              </span>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-lg border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-sm text-rose-200">
              {error}
            </div>
          ) : null}

          {result ? (
            <div className="rounded-lg border border-emerald-700/60 bg-emerald-900/25 px-4 py-3 text-sm">
              <div className="mb-1 font-semibold text-emerald-300">
                {t('adminMenu.importComplete')}
              </div>
              <ul className="space-y-0.5 opacity-90">
                <li>
                  {t('adminMenu.createdCategories', {
                    count: result.createdCategories,
                  })}
                </li>
                <li>
                  {t('adminMenu.createdItems', { count: result.created })}
                </li>
                <li>
                  {t('adminMenu.updatedItems', { count: result.updated })}
                </li>
                {result.skipped ? (
                  <li>
                    {t('adminMenu.skippedItems', { count: result.skipped })}
                  </li>
                ) : null}
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
                <div className="text-gray-400">
                  {t('adminMenu.planSummary', {
                    rows: plan.length,
                    create: counts.create,
                    update: counts.update,
                  })}
                  {newCategories.length
                    ? t('adminMenu.planNewCategories', {
                        count: newCategories.length,
                      })
                    : ''}
                </div>
                <label className="ml-auto flex cursor-pointer select-none items-center gap-2">
                  <input
                    type="checkbox"
                    checked={updateExisting}
                    onChange={(e) => setUpdateExisting(e.target.checked)}
                    disabled={importing}
                  />
                  {t('adminMenu.updateExisting')}
                </label>
              </div>

              <div className="rounded-lg border border-gray-800 overflow-hidden">
                <div className="max-h-[42vh] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-gray-800 text-left text-xs uppercase tracking-wide opacity-80">
                      <tr>
                        <th className="px-3 py-2">
                          {t('adminMenu.colCategory')}
                        </th>
                        <th className="px-3 py-2">{t('adminMenu.colItem')}</th>
                        <th className="px-3 py-2 text-right">
                          {t('adminMenu.colPrice')}
                        </th>
                        <th className="px-3 py-2 text-right">
                          {t('adminMenu.colVat')}
                        </th>
                        <th className="px-3 py-2">
                          {t('adminMenu.colStatus')}
                        </th>
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
                                {updateExisting
                                  ? t('adminMenu.statusUpdate')
                                  : t('adminMenu.statusSkip')}
                              </span>
                            ) : r.status === 'new-category' ? (
                              <span className="text-sky-300">
                                {t('adminMenu.statusNewCategory')}
                              </span>
                            ) : (
                              <span className="text-emerald-300">
                                {t('adminMenu.statusNew')}
                              </span>
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

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-white/7 px-4 py-3 sm:px-5">
          {importing ? (
            <span className="mr-auto text-[13px] text-gray-400">
              {t('adminMenu.importingProgress', {
                done: progress.done,
                total: progress.total,
              })}
            </span>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={importing}>
            {result ? t('common.close') : t('common.cancel')}
          </Button>
          {!result ? (
            <Button
              onClick={() => void runImport()}
              disabled={!plan.length || importing || disabled}
              loading={importing}
            >
              {importing
                ? t('adminMenu.importing')
                : t('adminMenu.importN', { count: plan.length })}
            </Button>
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
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [vat, setVat] = useState('0.2');
  const [isKg, setIsKg] = useState(false);

  const canSubmit = name.trim().length > 0 && price.length > 0 && !disabled;

  function submit() {
    onAdd({
      name: name.trim(),
      price: Number(price),
      vatRate: vat ? Number(vat) : undefined,
      isKg,
    });
  }

  return (
    <div className="space-y-4">
      <Field label={t('adminMenu.itemName')}>
        <Input
          autoFocus
          placeholder={t('adminMenu.itemNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) submit();
          }}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label={t('adminMenu.price')}>
          <Input
            placeholder="0.00"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
            disabled={disabled}
          />
        </Field>
        <Field label={t('adminMenu.vatRate')}>
          <Input
            placeholder="0.2"
            inputMode="decimal"
            value={vat}
            onChange={(e) => setVat(e.target.value.replace(/[^0-9.]/g, ''))}
            disabled={disabled}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={isKg}
          onChange={(e) => setIsKg(e.target.checked)}
          disabled={disabled}
        />
        {t('adminMenu.soldByKgLabel')}
      </label>

      <Button block disabled={!canSubmit} onClick={submit}>
        {t('adminMenu.addItem')}
      </Button>
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
  const { t } = useTranslation();
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

  const nextName = name.trim();
  const preset = CATEGORY_PRESETS.find(
    (p) => p.toLowerCase() === nextName.toLowerCase(),
  );
  const nameTaken = Boolean(
    preset &&
      allCategories.some(
        (c) =>
          Number(c.id) !== Number(category.id) &&
          String(c.name || '').toLowerCase() === preset.toLowerCase(),
      ),
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:items-end">
        <Field
          className="md:col-span-6"
          label={t('adminMenu.name')}
          error={nameTaken ? t('adminMenu.nameTaken') : undefined}
        >
          <Select
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
          >
            {!CATEGORY_PRESETS.some(
              (p) =>
                p.toLowerCase() === String(category.name || '').toLowerCase(),
            ) && (
              <option value={category.name}>
                {t('adminMenu.legacy', { name: category.name })}
              </option>
            )}
            {CATEGORY_PRESETS.map((n) => (
              <option key={n} value={n}>
                {presetLabel(t, n)}
              </option>
            ))}
          </Select>
        </Field>
        <Field className="md:col-span-6" label={t('adminMenu.color')}>
          <div className="flex items-center gap-2">
            <input
              type="color"
              className="h-[var(--pos-control-h)] w-12 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
              value={color}
              onChange={(e) => {
                setColor(e.target.value);
                setColorText(e.target.value);
              }}
              title={t('adminMenu.pickColor')}
              disabled={disabled}
            />
            <Input
              className="font-mono"
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
        </Field>
        <Field
          className="md:col-span-12"
          label={t('adminMenu.kdsDisplay')}
          hint={t('adminMenu.kdsHint')}
        >
          <KdsStationSelect
            value={kdsStation}
            onChange={setKdsStation}
            disabled={disabled}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:justify-end">
        <Button
          block
          disabled={disabled || nameTaken}
          onClick={() => {
            const norm =
              normalizeColorInput(colorText) ?? (color ? String(color) : null);
            if (nameTaken) return;
            onSave({
              name: name.trim(),
              color: norm,
              sortOrder: Number(sortOrder || 0),
              kdsStation: kdsStation || null,
            });
          }}
        >
          {t('common.save')}
        </Button>
        {showDelete ? (
          <Button
            variant="danger"
            disabled={disabled}
            onClick={() => onDelete()}
          >
            {t('common.delete')}
          </Button>
        ) : null}
      </div>
      {showDelete ? (
        <div className="text-[12px] text-gray-500">
          {t('adminMenu.deleteCategoryHint')}
        </div>
      ) : null}
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
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const active = Boolean(item.active);
  const stock = normalizeStock(item.stockLevel);
  const skuShown =
    Boolean(item.sku) &&
    item.sku.trim().toLowerCase() !== item.name.trim().toLowerCase();

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-3 px-4 py-2.5',
          !active && 'opacity-55',
        )}
        title={active ? undefined : t('adminMenu.itemHidden')}
      >
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate text-[13px] font-medium',
              active ? 'text-gray-100' : 'text-gray-400 line-through',
            )}
          >
            {item.name}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {kdsStation ? (
              <Badge className="text-[10px]">
                {kdsLinkLabel(t, kdsStation)}
              </Badge>
            ) : null}
            <Badge className="text-[10px]">
              {t('adminMenu.vat', { pct: vatPercent(item.vatRate) })}
            </Badge>
            {item.isKg ? (
              <Badge className="text-[10px]">{t('adminMenu.soldByKg')}</Badge>
            ) : null}
            {skuShown ? (
              <Badge className="text-[10px]">
                {t('adminMenu.sku', { sku: item.sku })}
              </Badge>
            ) : null}
            {stock === 'LOW' ? (
              <Badge
                tone="warn"
                className="inline-flex items-center gap-0.5 text-[10px]"
              >
                <IconWarningTriangle className="size-3" />
                {t('stockPanel.lowStock')}
                {item.stockRemaining != null &&
                Number.isFinite(Number(item.stockRemaining)) ? (
                  <span className="tabular-nums">
                    · {Math.max(0, Math.floor(Number(item.stockRemaining)))}
                  </span>
                ) : null}
              </Badge>
            ) : null}
            {stock === 'OUT' ? (
              <Badge tone="danger" className="text-[10px]">
                {t('stockPanel.outOfStock')}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-[14px] font-semibold tabular-nums text-gray-50">
          {Number(item.price).toFixed(2)}
        </div>
        <Switch
          checked={active}
          disabled={disabled}
          label={active ? t('adminMenu.itemActive') : t('adminMenu.itemHidden')}
          onChange={(next) => void onSave({ active: next })}
        />
        <KebabMenu
          label={t('common.moreActions')}
          disabled={disabled}
          items={[
            {
              label: t('common.edit'),
              onSelect: () => setEditing(true),
              disabled,
            },
            {
              label: t('common.delete'),
              danger: true,
              disabled,
              onSelect: () => void onDelete(),
            },
          ]}
        />
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
  const { t } = useTranslation();
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
    <Modal
      title={t('adminMenu.editItem', { name: item.name })}
      onClose={onClose}
    >
      <div className="space-y-4">
        <Field
          label={t('adminMenu.itemName')}
          hint={t('adminMenu.sku', { sku: item.sku })}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t('adminMenu.price')}>
            <Input
              placeholder="0.00"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
              disabled={disabled}
            />
          </Field>
          <Field label={t('adminMenu.vatRate')}>
            <Input
              placeholder="0.2"
              inputMode="decimal"
              value={vat}
              onChange={(e) => setVat(e.target.value.replace(/[^0-9.]/g, ''))}
              disabled={disabled}
            />
          </Field>
        </div>

        <Field label={t('adminMenu.waiterAvailability')}>
          <Select
            value={stockLevel}
            onChange={(e) => setStockLevel(e.target.value as StockLevel)}
            disabled={disabled}
          >
            <option value="OK">{t('adminMenu.inStock')}</option>
            <option value="LOW">{t('adminMenu.lowStockWarn')}</option>
            <option value="OUT">{t('adminMenu.outOfStockUnavail')}</option>
          </Select>
        </Field>

        {stockLevel === 'LOW' ? (
          <Field
            label={t('adminMenu.howManyLeft')}
            hint={t('adminMenu.stockHint')}
          >
            <Input
              type="number"
              min={1}
              step={1}
              className="max-w-xs"
              value={stockQty}
              onChange={(e) => setStockQty(e.target.value)}
              disabled={disabled}
            />
          </Field>
        ) : null}

        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={isKg}
              onChange={(e) => setIsKg(e.target.checked)}
              disabled={disabled}
            />
            {t('adminMenu.soldByKgLabel')}
          </label>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px]">
              {active ? t('adminMenu.enabled') : t('adminMenu.disabled')}
            </span>
            <Switch
              checked={active}
              disabled={disabled}
              label={
                active ? t('adminMenu.itemActive') : t('adminMenu.itemHidden')
              }
              onChange={setActive}
            />
          </div>
        </div>

        <Button
          block
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
              patch.stockRemaining = Math.max(1, Math.floor(stockQtyNum || 1));
            }
            return onSave(patch);
          }}
        >
          {t('common.save')}
        </Button>
      </div>
    </Modal>
  );
}
