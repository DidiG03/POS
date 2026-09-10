import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchInput, Select, Input } from './ui/Field';
import { cn } from './ui/cn';

export type StockLevel = 'OK' | 'LOW' | 'OUT';

export type StockPanelMenuItem = {
  id: number;
  name: string;
  sku: string;
  stockLevel?: 'OK' | 'LOW' | 'OUT';
  stockRemaining?: number | null;
};

export type StockPanelMenuCategory = {
  id: number;
  name: string;
  items: StockPanelMenuItem[];
};

export type StockPanelChangeOpts = {
  stockRemaining?: number;
};

export function normalizeStock(raw: unknown): StockLevel {
  const s = String(raw ?? 'OK').toUpperCase();
  if (s === 'LOW') return 'LOW';
  if (s === 'OUT') return 'OUT';
  return 'OK';
}

function parsePositiveInt(raw: string, fallback: number): number {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export function StockAvailabilityPanel({
  categories,
  disabled,
  onChangeLevel,
  hideTitle,
}: {
  categories: StockPanelMenuCategory[];
  disabled: boolean;
  onChangeLevel: (
    itemId: number,
    level: StockLevel,
    opts?: StockPanelChangeOpts,
  ) => Promise<void>;
  hideTitle?: boolean;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  /** Draft qty strings while typing — committed on blur / level change */
  const [qtyDraft, setQtyDraft] = useState<Record<number, string>>({});

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const flat = categories.flatMap((c) =>
      (c.items || []).map((item) => ({
        ...item,
        categoryName: c.name,
      })),
    );
    flat.sort((a, b) => a.name.localeCompare(b.name));
    if (!needle) return flat;
    return flat.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.sku.toLowerCase().includes(needle) ||
        row.categoryName.toLowerCase().includes(needle),
    );
  }, [categories, q]);

  useEffect(() => {
    const next: Record<number, string> = {};
    for (const c of categories) {
      for (const it of c.items || []) {
        if (
          it.stockRemaining != null &&
          Number.isFinite(Number(it.stockRemaining))
        ) {
          next[it.id] = String(
            Math.max(1, Math.floor(Number(it.stockRemaining))),
          );
        }
      }
    }
    setQtyDraft((prev) => {
      const merged = { ...prev };
      for (const [idStr, v] of Object.entries(next)) {
        const id = Number(idStr);
        if (merged[id] === undefined) merged[id] = v;
      }
      return merged;
    });
  }, [categories]);

  return (
    <section>
      <div
        className={cn(
          'mb-3 flex items-end gap-3',
          hideTitle ? 'justify-end' : 'justify-between',
        )}
      >
        {hideTitle ? null : (
          <div className="text-sm text-gray-500">{t('stockPanel.title')}</div>
        )}
        <SearchInput
          value={q}
          onValueChange={setQ}
          placeholder={t('stockPanel.searchPlaceholder')}
          disabled={disabled}
          className="w-full sm:w-56"
        />
      </div>
      <div className="max-h-[min(70vh,40rem)] overflow-auto">
        <table className="pos-table">
          <thead>
            <tr>
              <th>{t('stockPanel.colItem')}</th>
              <th className="hidden sm:table-cell">
                {t('stockPanel.colCategory')}
              </th>
              <th className="w-[88px]">{t('stockPanel.colLeft')}</th>
              <th className="w-[148px]">{t('stockPanel.colAvailability')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-gray-500">
                  {t('stockPanel.noItemsMatch')}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const level = normalizeStock(row.stockLevel);
                const qtyStr =
                  qtyDraft[row.id] ??
                  (row.stockRemaining != null
                    ? String(
                        Math.max(1, Math.floor(Number(row.stockRemaining))),
                      )
                    : '1');

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
                    <td className="align-middle">
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        disabled={disabled || level !== 'LOW'}
                        className="w-full text-[12px]"
                        value={level === 'LOW' ? qtyStr : ''}
                        placeholder={level === 'LOW' ? undefined : '—'}
                        title={
                          level === 'LOW'
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
                          if (level !== 'LOW' || disabled) return;
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
                    <td>
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
                        <option value="LOW">{t('stockPanel.lowStock')}</option>
                        <option value="OUT">
                          {t('stockPanel.outOfStock')}
                        </option>
                      </Select>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
