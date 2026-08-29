import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

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

export function IconWarningTriangle({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className ?? 'pos-icon w-4 h-4 shrink-0'}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.577 4.5-2.598 4.5H4.645c-2.021 0-3.752-2.5-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  );
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
        className={`flex flex-col sm:flex-row sm:items-center gap-3 mb-2 ${hideTitle ? 'sm:justify-end' : 'sm:justify-between'}`}
      >
        {hideTitle ? null : (
          <div className="text-sm opacity-70">{t('stockPanel.title')}</div>
        )}
        <input
          type="search"
          placeholder={t('stockPanel.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={disabled}
          className="w-full sm:w-56 bg-gray-700 rounded px-3 py-2 text-sm shrink-0"
        />
      </div>
      <div className="overflow-auto max-h-[min(70vh,40rem)] border border-gray-700 rounded">
        <table className="w-full text-sm">
          <thead className="text-left bg-gray-900 sticky top-0 z-10">
            <tr className="opacity-70">
              <th className="py-2 px-3">{t('stockPanel.colItem')}</th>
              <th className="py-2 px-3 hidden sm:table-cell">
                {t('stockPanel.colCategory')}
              </th>
              <th className="py-2 px-3 w-[88px]">{t('stockPanel.colLeft')}</th>
              <th className="py-2 px-3 w-[148px]">
                {t('stockPanel.colAvailability')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="border-t border-gray-800">
                <td colSpan={4} className="py-3 px-3 opacity-70">
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
                  <tr key={row.id} className="border-t border-gray-800">
                    <td className="py-2 px-3">
                      <div className="font-medium truncate max-w-[200px] sm:max-w-xs">
                        {row.name}
                      </div>
                      <div className="text-xs opacity-70 font-mono truncate">
                        {row.sku}
                      </div>
                    </td>
                    <td className="py-2 px-3 hidden sm:table-cell opacity-90">
                      {row.categoryName}
                    </td>
                    <td className="py-2 px-3 align-middle">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        disabled={disabled || level !== 'LOW'}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs disabled:opacity-40"
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
                    <td className="py-2 px-3">
                      <select
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs"
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
                      </select>
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
