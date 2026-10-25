import { useCallback, useEffect, useState } from 'react';
import { effectiveVatRate } from '@shared/ticketRevenue';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';

/**
 * VAT to take out of a menu price before comparing it with a cost. Menu
 * prices include VAT, which is the tax office's money; a margin on the
 * gross price showed a 1200 dish costing 600 as 50% when it is 40%.
 */
export function useCostVat(): (itemVatRate: unknown) => number {
  const [vat, setVat] = useState<{ enabled: boolean; defaultRate: number }>({
    enabled: false,
    defaultRate: 0,
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await window.api.settings.get().catch(() => null);
      if (!alive || !s) return;
      setVat({
        enabled: isVatEnabledFromSettings(s),
        defaultRate: Number((s as any)?.defaultVatRate) || 0,
      });
    })();
    return () => {
      alive = false;
    };
  }, []);
  return useCallback(
    (itemVatRate: unknown) =>
      vat.enabled ? effectiveVatRate(itemVatRate, vat.defaultRate) : 0,
    [vat],
  );
}
