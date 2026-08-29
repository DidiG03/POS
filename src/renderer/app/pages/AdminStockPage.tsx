import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageSpinner } from '../../components/PageSpinner';
import {
  normalizeStock,
  StockAvailabilityPanel,
  type StockPanelMenuCategory,
} from '../../components/StockAvailabilityPanel';

export default function AdminStockPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [billingPaused, setBillingPaused] = useState(false);
  const [categories, setCategories] = useState<StockPanelMenuCategory[]>([]);

  async function reload() {
    setErr(null);
    try {
      const data = await window.api.menu.listCategoriesWithItems();
      setCategories((data as StockPanelMenuCategory[]) || []);
    } catch (e: any) {
      setErr(e?.message || t('stockPanel.loadFailed'));
      setCategories([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await window.api.menu.listCategoriesWithItems();
        if (!cancelled) setCategories((data as StockPanelMenuCategory[]) || []);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || t('stockPanel.loadFailed'));
          setCategories([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

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

  const totals = useMemo(() => {
    let ok = 0;
    let low = 0;
    let out = 0;
    for (const c of categories) {
      for (const it of c.items || []) {
        const level = normalizeStock(it.stockLevel);
        if (level === 'LOW') low += 1;
        else if (level === 'OUT') out += 1;
        else ok += 1;
      }
    }
    return { ok, low, out };
  }, [categories]);

  if (loading) return <PageSpinner message={t('stockPanel.loading')} />;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-gray-700 bg-gray-800/70 p-4">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">{t('stockPanel.title')}</h2>
          </div>
          <button
            type="button"
            className="self-start text-xs px-2.5 py-1.5 rounded bg-gray-700 hover:bg-gray-600"
            onClick={() => void reload()}
          >
            {t('adminOverview.refresh')}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <MiniStat label={t('stockPanel.inStock')} value={totals.ok} />
          <MiniStat label={t('stockPanel.lowStock')} value={totals.low} />
          <MiniStat label={t('stockPanel.outOfStock')} value={totals.out} />
        </div>
      </section>

      {err && (
        <div className="bg-rose-900/30 border border-rose-700 text-rose-200 rounded-lg p-3 text-sm">
          {err}
        </div>
      )}

      {billingPaused && (
        <div className="bg-amber-900/20 border border-amber-800 text-amber-200 rounded-lg p-3 text-sm">
          {t('stockPanel.billingPaused')}
        </div>
      )}

      <section className="rounded-xl border border-gray-700 bg-gray-800/70 p-4 min-w-0 overflow-hidden">
        <StockAvailabilityPanel
          categories={categories}
          disabled={billingPaused || saving}
          hideTitle
          onChangeLevel={async (itemId, stockLevel, opts) => {
            setSaving(true);
            setErr(null);
            try {
              const payload: Record<string, unknown> = {
                id: itemId,
                stockLevel,
              };
              if (stockLevel === 'LOW' && opts?.stockRemaining != null) {
                payload.stockRemaining = opts.stockRemaining;
              }
              await window.api.menu.updateItem(payload as any);
              await reload();
            } catch (e: any) {
              setErr(e?.message || t('stockPanel.saveFailed'));
            } finally {
              setSaving(false);
            }
          }}
        />
      </section>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
