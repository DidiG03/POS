import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageSpinner } from '../../components/PageSpinner';
import {
  effectiveStockLevel,
  StockAvailabilityPanel,
  type StockPanelMenuCategory,
} from '../../components/StockAvailabilityPanel';
import { formatCostMoney } from '../../components/ItemCostFields';
import { itemCostFigures, resolveUnitCost } from '@shared/itemCost';
import { IconAlert } from '../../components/icons';
import { reportAppError } from '../../utils/reportAppError';
import { cn } from '../../components/ui/cn';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';

export default function AdminStockPage() {
  const { t } = useTranslation();
  const trackInventory = !useLicenseCapabilities((s) => s.hasTables);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [billingPaused, setBillingPaused] = useState(false);
  const [categories, setCategories] = useState<StockPanelMenuCategory[]>([]);
  const [currency, setCurrency] = useState('EUR');

  async function reload() {
    setErr(null);
    try {
      const data = await window.api.menu.listCategoriesWithItems();
      setCategories((data as StockPanelMenuCategory[]) || []);
    } catch (e: any) {
      setErr(e?.message || t('stockPanel.loadFailed'));
      reportAppError(e, {
        fallback: t('stockPanel.loadFailed'),
        key: 'stock.load',
      });
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
          reportAppError(e, {
            fallback: t('stockPanel.loadFailed'),
            key: 'stock.load',
          });
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
        const s = await window.api.settings.get().catch(() => null as any);
        const cur = String((s as any)?.currency || '').trim();
        if (cur) setCurrency(cur);
      } catch {
        /* keep EUR */
      }
    })();
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

  const totals = useMemo(() => {
    let ok = 0;
    let low = 0;
    let out = 0;
    for (const c of categories) {
      for (const it of c.items || []) {
        const level = effectiveStockLevel(it, trackInventory);
        if (level === 'LOW') low += 1;
        else if (level === 'OUT') out += 1;
        else ok += 1;
      }
    }
    return { ok, low, out };
  }, [categories, trackInventory]);

  const valueTotals = useMemo(() => {
    let stockValue = 0;
    let stockProfit = 0;
    let withCost = 0;
    for (const c of categories) {
      for (const it of c.items || []) {
        const cost = resolveUnitCost(it.costPrice, it.costBreakdown);
        const onHand =
          it.stockRemaining != null &&
          Number.isFinite(Number(it.stockRemaining))
            ? Number(it.stockRemaining)
            : null;
        const figs = itemCostFigures({
          sellPrice: Number(it.price || 0),
          cost,
          onHand,
        });
        if (figs.stockValue != null) {
          stockValue += figs.stockValue;
          withCost += 1;
        }
        if (figs.stockProfit != null) stockProfit += figs.stockProfit;
      }
    }
    return { stockValue, stockProfit, withCost };
  }, [categories]);

  if (loading) return <PageSpinner message={t('stockPanel.loading')} />;

  return (
    <div className="admin-page">
      <section>
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
          {trackInventory ? (
            <>
              <div className="admin-metric">
                <div className="admin-metric-label">
                  {t('stockPanel.stockValue')}
                </div>
                <div
                  className={cn(
                    'admin-metric-value is-text',
                    valueTotals.withCost === 0 && 'is-quiet',
                  )}
                >
                  {formatCostMoney(valueTotals.stockValue, currency)}
                </div>
              </div>
              <div className="admin-metric">
                <div className="admin-metric-label">
                  {t('stockPanel.stockProfit')}
                </div>
                <div
                  className={cn(
                    'admin-metric-value is-text',
                    valueTotals.withCost === 0
                      ? 'is-quiet'
                      : valueTotals.stockProfit < 0
                        ? 'text-rose-300'
                        : 'text-emerald-300',
                  )}
                >
                  {formatCostMoney(valueTotals.stockProfit, currency)}
                </div>
              </div>
            </>
          ) : null}
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
        trackInventory={trackInventory}
        currency={currency}
        onSaveCost={
          trackInventory
            ? async (itemId, next) => {
                setSaving(true);
                setErr(null);
                try {
                  await window.api.menu.updateItem({
                    id: itemId,
                    costPrice: next.costPrice,
                    costBreakdown: next.costBreakdown,
                  } as any);
                  await reload();
                } catch (e: any) {
                  setErr(e?.message || t('stockPanel.saveFailed'));
                  throw e;
                } finally {
                  setSaving(false);
                }
              }
            : undefined
        }
        onChangeLevel={async (itemId, stockLevel, opts) => {
          setSaving(true);
          setErr(null);
          try {
            const payload: Record<string, unknown> = {
              id: itemId,
              stockLevel,
            };
            if (trackInventory && opts?.stockRemaining != null) {
              payload.stockRemaining = opts.stockRemaining;
            } else if (stockLevel === 'LOW' && opts?.stockRemaining != null) {
              payload.stockRemaining = opts.stockRemaining;
            }
            await window.api.menu.updateItem(payload as any);
            await reload();
          } catch (e: any) {
            setErr(e?.message || t('stockPanel.saveFailed'));
            reportAppError(e, {
              fallback: t('stockPanel.saveFailed'),
              key: `stock.save:${itemId}`,
            });
          } finally {
            setSaving(false);
          }
        }}
      />
    </div>
  );
}
