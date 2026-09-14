import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inventoryLevelFromOnHand } from '@shared/menuStock';
import {
  itemCostFigures,
  resolveUnitCost,
  type ItemCostLine,
} from '@shared/itemCost';
import { SearchInput, Select, Input } from './ui/Field';
import { IconButton } from './ui/Button';
import { Badge } from './ui/Badge';
import { IconPlus, IconEdit } from './icons';
import { cn } from './ui/cn';
import {
  formatCostMoney,
  formatMarginPct,
  ItemCostModal,
  marginClassName,
} from './ItemCostFields';

export type StockLevel = 'OK' | 'LOW' | 'OUT';

export type StockPanelMenuItem = {
  id: number;
  name: string;
  sku: string;
  price?: number;
  stockLevel?: 'OK' | 'LOW' | 'OUT';
  stockRemaining?: number | null;
  costPrice?: number | null;
  costBreakdown?: ItemCostLine[] | null;
};

export type StockPanelMenuCategory = {
  id: number;
  name: string;
  items: StockPanelMenuItem[];
};

export type StockPanelChangeOpts = {
  stockRemaining?: number;
};

export type StockPanelCostSave = {
  costPrice: number | null;
  costBreakdown: ItemCostLine[] | null;
};

export function normalizeStock(raw: unknown): StockLevel {
  const s = String(raw ?? 'OK').toUpperCase();
  if (s === 'LOW') return 'LOW';
  if (s === 'OUT') return 'OUT';
  return 'OK';
}

export function effectiveStockLevel(
  item: Pick<StockPanelMenuItem, 'stockLevel' | 'stockRemaining'>,
  trackInventory: boolean,
): StockLevel {
  if (
    trackInventory &&
    item.stockRemaining != null &&
    Number.isFinite(Number(item.stockRemaining))
  ) {
    return inventoryLevelFromOnHand(Number(item.stockRemaining));
  }
  return normalizeStock(item.stockLevel);
}

function parseNonNegInt(raw: string, fallback: number): number {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parsePositiveInt(raw: string, fallback: number): number {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

type StockFilter = 'all' | 'ok' | 'low' | 'out' | 'untracked';

export function StockAvailabilityPanel({
  categories,
  disabled,
  onChangeLevel,
  hideTitle,
  trackInventory = false,
  currency = 'EUR',
  onSaveCost,
}: {
  categories: StockPanelMenuCategory[];
  disabled: boolean;
  onChangeLevel: (
    itemId: number,
    level: StockLevel,
    opts?: StockPanelChangeOpts,
  ) => Promise<void>;
  hideTitle?: boolean;
  /** Store: persistent on-hand qty, receive, auto low/out. */
  trackInventory?: boolean;
  currency?: string;
  onSaveCost?: (itemId: number, next: StockPanelCostSave) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<StockFilter>('all');
  /** Draft qty strings while typing — committed on blur / level change */
  const [qtyDraft, setQtyDraft] = useState<Record<number, string>>({});
  const [receiveDraft, setReceiveDraft] = useState<Record<number, string>>({});
  const [costItemId, setCostItemId] = useState<number | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const flat = categories.flatMap((c) =>
      (c.items || []).map((item) => ({
        ...item,
        categoryName: c.name,
      })),
    );
    flat.sort((a, b) => a.name.localeCompare(b.name));
    const searched = !needle
      ? flat
      : flat.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            row.sku.toLowerCase().includes(needle) ||
            row.categoryName.toLowerCase().includes(needle),
        );
    if (filter === 'all') return searched;
    return searched.filter((row) => {
      const tracked =
        row.stockRemaining != null &&
        Number.isFinite(Number(row.stockRemaining));
      const level = effectiveStockLevel(row, trackInventory);
      if (filter === 'untracked') return !tracked;
      if (filter === 'ok') return tracked && level === 'OK';
      if (filter === 'low') return level === 'LOW';
      if (filter === 'out') return level === 'OUT';
      return true;
    });
  }, [categories, q, filter, trackInventory]);

  useEffect(() => {
    const next: Record<number, string> = {};
    for (const c of categories) {
      for (const it of c.items || []) {
        if (
          it.stockRemaining != null &&
          Number.isFinite(Number(it.stockRemaining))
        ) {
          next[it.id] = String(
            Math.max(0, Math.floor(Number(it.stockRemaining))),
          );
        }
      }
    }
    setQtyDraft((prev) => {
      const merged: Record<number, string> = {};
      for (const [idStr, v] of Object.entries(next)) {
        const id = Number(idStr);
        merged[id] = prev[id] !== undefined ? prev[id] : v;
      }
      return merged;
    });
  }, [categories]);

  function commitOnHand(rowId: number, onHand: number) {
    const level = inventoryLevelFromOnHand(onHand);
    setQtyDraft((prev) => ({ ...prev, [rowId]: String(onHand) }));
    void onChangeLevel(rowId, level, { stockRemaining: onHand });
  }

  const costItem = useMemo(() => {
    if (costItemId == null) return null;
    for (const c of categories) {
      const it = (c.items || []).find((i) => i.id === costItemId);
      if (it) return it;
    }
    return null;
  }, [categories, costItemId]);

  const showCost = Boolean(trackInventory && onSaveCost);
  const colSpan = showCost ? 9 : trackInventory ? 5 : 4;

  return (
    <section>
      <div
        className={cn(
          'mb-3 flex flex-wrap items-end gap-3',
          hideTitle ? 'justify-end' : 'justify-between',
        )}
      >
        {hideTitle ? null : (
          <div className="text-sm text-gray-500">{t('stockPanel.title')}</div>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          {trackInventory ? (
            <Select
              className="w-auto shrink-0 text-[12px]"
              value={filter}
              onChange={(e) => setFilter(e.target.value as StockFilter)}
              disabled={disabled}
            >
              <option value="all">{t('stockPanel.filterAll')}</option>
              <option value="ok">{t('stockPanel.inStock')}</option>
              <option value="low">{t('stockPanel.lowStock')}</option>
              <option value="out">{t('stockPanel.outOfStock')}</option>
              <option value="untracked">{t('stockPanel.untracked')}</option>
            </Select>
          ) : null}
          <SearchInput
            value={q}
            onValueChange={setQ}
            placeholder={t('stockPanel.searchPlaceholder')}
            disabled={disabled}
            className="w-full sm:w-56"
          />
        </div>
      </div>
      <div className="max-h-[min(70vh,40rem)] overflow-auto">
        <table className="pos-table">
          <thead>
            <tr>
              <th>{t('stockPanel.colItem')}</th>
              <th className="hidden sm:table-cell">
                {t('stockPanel.colCategory')}
              </th>
              {showCost ? (
                <>
                  <th className="w-[92px]">{t('stockPanel.colCost')}</th>
                  <th className="hidden w-[92px] md:table-cell">
                    {t('stockPanel.colPrice')}
                  </th>
                  <th className="w-[80px]">{t('stockPanel.colMargin')}</th>
                </>
              ) : null}
              <th className="w-[88px]">
                {t(
                  trackInventory
                    ? 'stockPanel.colOnHand'
                    : 'stockPanel.colLeft',
                )}
              </th>
              {trackInventory ? (
                <th className="w-[132px]">{t('stockPanel.colReceive')}</th>
              ) : null}
              <th className="w-[148px]">{t('stockPanel.colAvailability')}</th>
              {showCost ? <th className="w-10" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="text-gray-500">
                  {t('stockPanel.noItemsMatch')}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const tracked =
                  row.stockRemaining != null &&
                  Number.isFinite(Number(row.stockRemaining));
                const level = effectiveStockLevel(row, trackInventory);
                const qtyStr =
                  qtyDraft[row.id] ??
                  (tracked
                    ? String(
                        Math.max(0, Math.floor(Number(row.stockRemaining))),
                      )
                    : '');
                const receiveStr = receiveDraft[row.id] ?? '';

                return (
                  <tr key={row.id}>
                    <td>
                      <div className="max-w-[200px] truncate font-medium sm:max-w-xs">
                        {row.name}
                      </div>
                      <div className="truncate font-mono text-[11px] text-gray-500">
                        {row.sku}
                      </div>
                    </td>
                    <td className="hidden sm:table-cell text-gray-400">
                      {row.categoryName}
                    </td>
                    {showCost ? (
                      <CostCells row={row} currency={currency} />
                    ) : null}
                    <td className="align-middle">
                      <Input
                        type="number"
                        min={trackInventory ? 0 : 1}
                        step={1}
                        disabled={
                          disabled || (!trackInventory && level !== 'LOW')
                        }
                        className="w-full text-[12px]"
                        value={
                          trackInventory
                            ? qtyStr
                            : level === 'LOW'
                              ? qtyStr || '1'
                              : ''
                        }
                        placeholder={
                          trackInventory
                            ? t('stockPanel.untrackedPlaceholder')
                            : '—'
                        }
                        title={
                          trackInventory
                            ? t('stockPanel.onHandTitle')
                            : level === 'LOW'
                              ? t('stockPanel.portionsLeftTitle')
                              : undefined
                        }
                        onChange={(e) =>
                          setQtyDraft((prev) => ({
                            ...prev,
                            [row.id]: e.target.value,
                          }))
                        }
                        onBlur={() => {
                          if (disabled) return;
                          if (trackInventory) {
                            const raw = (qtyDraft[row.id] ?? qtyStr).trim();
                            if (!raw) return;
                            const qv = parseNonNegInt(raw, 0);
                            commitOnHand(row.id, qv);
                            return;
                          }
                          if (level !== 'LOW') return;
                          const qv = parsePositiveInt(
                            qtyDraft[row.id] ?? qtyStr,
                            1,
                          );
                          setQtyDraft((prev) => ({
                            ...prev,
                            [row.id]: String(qv),
                          }));
                          void onChangeLevel(row.id, 'LOW', {
                            stockRemaining: qv,
                          });
                        }}
                      />
                    </td>
                    {trackInventory ? (
                      <td className="align-middle">
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={1}
                            step={1}
                            disabled={disabled}
                            className="min-w-0 flex-1 text-[12px]"
                            value={receiveStr}
                            placeholder="1"
                            title={t('stockPanel.receiveTitle')}
                            onChange={(e) =>
                              setReceiveDraft((prev) => ({
                                ...prev,
                                [row.id]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter' || disabled) return;
                              e.preventDefault();
                              const add = parsePositiveInt(
                                receiveDraft[row.id] ?? '1',
                                1,
                              );
                              const current = tracked
                                ? parseNonNegInt(qtyStr, 0)
                                : 0;
                              commitOnHand(row.id, current + add);
                              setReceiveDraft((prev) => ({
                                ...prev,
                                [row.id]: '',
                              }));
                            }}
                          />
                          <IconButton
                            label={t('stockPanel.receive')}
                            icon={<IconPlus />}
                            disabled={disabled}
                            onClick={() => {
                              const add = parsePositiveInt(
                                receiveDraft[row.id] ?? '1',
                                1,
                              );
                              const current = tracked
                                ? parseNonNegInt(qtyStr, 0)
                                : 0;
                              commitOnHand(row.id, current + add);
                              setReceiveDraft((prev) => ({
                                ...prev,
                                [row.id]: '',
                              }));
                            }}
                          />
                        </div>
                      </td>
                    ) : null}
                    <td>
                      {trackInventory ? (
                        <Badge
                          tone={
                            !tracked
                              ? 'neutral'
                              : level === 'OUT'
                                ? 'danger'
                                : level === 'LOW'
                                  ? 'warn'
                                  : 'accent'
                          }
                        >
                          {!tracked
                            ? t('stockPanel.untracked')
                            : level === 'OUT'
                              ? t('stockPanel.outOfStock')
                              : level === 'LOW'
                                ? t('stockPanel.lowStock')
                                : t('stockPanel.inStock')}
                        </Badge>
                      ) : (
                        <Select
                          className="w-full text-[12px]"
                          value={level}
                          disabled={disabled}
                          onChange={(e) => {
                            const next = e.target.value as StockLevel;
                            if (next === level) return;
                            if (next === 'LOW') {
                              const qv = parsePositiveInt(
                                qtyDraft[row.id] ?? qtyStr,
                                1,
                              );
                              setQtyDraft((prev) => ({
                                ...prev,
                                [row.id]: String(qv),
                              }));
                              void onChangeLevel(row.id, 'LOW', {
                                stockRemaining: qv,
                              });
                            } else if (next === 'OUT') {
                              void onChangeLevel(row.id, 'OUT');
                            } else {
                              void onChangeLevel(row.id, 'OK');
                            }
                          }}
                        >
                          <option value="OK">{t('stockPanel.inStock')}</option>
                          <option value="LOW">
                            {t('stockPanel.lowStock')}
                          </option>
                          <option value="OUT">
                            {t('stockPanel.outOfStock')}
                          </option>
                        </Select>
                      )}
                    </td>
                    {showCost ? (
                      <td className="align-middle text-right">
                        <IconButton
                          label={t('stockPanel.editCost')}
                          icon={<IconEdit />}
                          disabled={disabled}
                          onClick={() => setCostItemId(row.id)}
                        />
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {showCost && costItem ? (
        <ItemCostModal
          open
          onClose={() => setCostItemId(null)}
          itemName={costItem.name}
          sellPrice={Number(costItem.price || 0)}
          costPrice={costItem.costPrice}
          costBreakdown={costItem.costBreakdown}
          onHand={
            costItem.stockRemaining != null &&
            Number.isFinite(Number(costItem.stockRemaining))
              ? Number(costItem.stockRemaining)
              : null
          }
          currency={currency}
          disabled={disabled}
          onSave={async (next) => {
            await onSaveCost?.(costItem.id, next);
          }}
        />
      ) : null}
    </section>
  );
}

function CostCells({
  row,
  currency,
}: {
  row: StockPanelMenuItem;
  currency: string;
}) {
  const cost = resolveUnitCost(row.costPrice, row.costBreakdown);
  const figures = itemCostFigures({
    sellPrice: Number(row.price || 0),
    cost,
  });
  const money = (n: number | null) =>
    n == null ? '—' : formatCostMoney(n, currency);
  return (
    <>
      <td className="align-middle text-[12px] tabular-nums">
        {money(figures.cost)}
      </td>
      <td className="hidden align-middle text-[12px] tabular-nums md:table-cell">
        {formatCostMoney(Number(row.price || 0), currency)}
      </td>
      <td
        className={cn(
          'align-middle text-[12px] font-medium tabular-nums',
          marginClassName(figures.marginPct, figures.profit),
        )}
      >
        {formatMarginPct(figures.marginPct)}
      </td>
    </>
  );
}
