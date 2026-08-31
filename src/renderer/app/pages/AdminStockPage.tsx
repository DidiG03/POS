import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageSpinner } from '../../components/PageSpinner';
import {
  normalizeStock,
  StockAvailabilityPanel,
  type StockPanelMenuCategory,
} from '../../components/StockAvailabilityPanel';
import { Button, Card, PageHeader, Stat } from '../../components/ui';
import { IconAlert, IconRefresh } from '../../components/icons';

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
    <div className="mx-auto w-full max-w-[1400px] space-y-4 sm:space-y-5">
      <PageHeader
        title={t('stockPanel.title')}
        actions={
          <Button
            icon={<IconRefresh />}
            onClick={() => void reload()}
            disabled={saving}
          >
            {t('adminOverview.refresh')}
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <Stat label={t('stockPanel.inStock')} value={totals.ok} />
        <Stat
          label={t('stockPanel.lowStock')}
          value={totals.low}
          tone={totals.low > 0 ? 'warn' : 'default'}
        />
        <Stat
          label={t('stockPanel.outOfStock')}
          value={totals.out}
          tone={totals.out > 0 ? 'danger' : 'default'}
        />
      </div>

      {err && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-500/8 px-3 py-2.5 text-[13px] text-rose-200">
          <IconAlert className="pos-icon mt-px shrink-0 text-rose-400" />
          <span className="min-w-0">{err}</span>
        </div>
      )}

      {billingPaused && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-[13px] text-amber-200">
          <IconAlert className="pos-icon mt-px shrink-0 text-amber-400" />
          <span className="min-w-0">{t('stockPanel.billingPaused')}</span>
        </div>
      )}

      <Card className="min-w-0 overflow-hidden">
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
      </Card>
    </div>
  );
}
