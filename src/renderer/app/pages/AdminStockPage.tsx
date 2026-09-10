import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageSpinner } from '../../components/PageSpinner';
import {
  normalizeStock,
  StockAvailabilityPanel,
  type StockPanelMenuCategory,
} from '../../components/StockAvailabilityPanel';
import { Button } from '../../components/ui';
import { IconAlert, IconRefresh } from '../../components/icons';
import { cn } from '../../components/ui/cn';

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
    <div className="admin-page">
      <section>
        <div className="mb-3 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            icon={<IconRefresh />}
            onClick={() => void reload()}
            disabled={saving}
          >
            {t('adminOverview.refresh')}
          </Button>
        </div>
        <div className="admin-metrics">
          <div className="admin-metric">
            <div className="admin-metric-label">{t('stockPanel.inStock')}</div>
            <div
              className={cn(
                'admin-metric-value',
                totals.ok === 0 && 'is-quiet',
              )}
            >
              {totals.ok}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">{t('stockPanel.lowStock')}</div>
            <div
              className={cn(
                'admin-metric-value',
                totals.low === 0 ? 'is-quiet' : 'text-amber-300',
              )}
            >
              {totals.low}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">
              {t('stockPanel.outOfStock')}
            </div>
            <div
              className={cn(
                'admin-metric-value',
                totals.out === 0 ? 'is-quiet' : 'text-rose-300',
              )}
            >
              {totals.out}
            </div>
          </div>
        </div>
      </section>

      {err && (
        <div className="flex items-start gap-2 text-[13px] text-rose-200">
          <IconAlert className="pos-icon mt-px shrink-0 text-rose-400" />
          <span className="min-w-0">{err}</span>
        </div>
      )}

      {billingPaused && (
        <div className="flex items-start gap-2 text-[13px] text-amber-200">
          <IconAlert className="pos-icon mt-px shrink-0 text-amber-400" />
          <span className="min-w-0">{t('stockPanel.billingPaused')}</span>
        </div>
      )}

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
    </div>
  );
}
