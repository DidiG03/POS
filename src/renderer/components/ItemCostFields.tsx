import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  costWritePayload,
  emptyCostLine,
  itemCostFigures,
  seedCostLines,
  sumCostLines,
  type ItemCostLine,
} from '@shared/itemCost';
import { Field, Input } from './ui/Field';
import { Button, IconButton } from './ui/Button';
import { Modal } from './ui/Modal';
import { IconPlus, IconTrash } from './icons';
import { cn } from './ui/cn';

export function formatCostMoney(amount: number, currency: string): string {
  const n = Math.round(Number.isFinite(amount) ? amount : 0);
  const cur = String(currency || 'EUR').trim() || 'EUR';
  const iso = /^[A-Z]{3}$/i.test(cur) ? cur.toUpperCase() : 'EUR';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: iso,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

export function formatMarginPct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}%`;
}

export function marginClassName(
  marginPct: number | null,
  profit: number | null,
): string {
  if (profit == null || marginPct == null) return 'text-gray-500';
  if (profit < 0) return 'text-rose-300';
  if (marginPct >= 30) return 'text-emerald-300';
  if (marginPct >= 10) return 'text-amber-300';
  return 'text-rose-300';
}

function parseMoney(raw: string): number {
  const n = Number(String(raw).replace(',', '.').trim());
  return Number.isFinite(n) ? n : 0;
}

export function ItemCostFields({
  sellPrice,
  onSellPriceChange,
  showSellPrice = true,
  lines,
  onChangeLines,
  onHand,
  currency,
  disabled,
}: {
  sellPrice: string;
  onSellPriceChange?: (next: string) => void;
  showSellPrice?: boolean;
  lines: ItemCostLine[];
  onChangeLines: (next: ItemCostLine[]) => void;
  onHand?: number | null;
  currency: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [amountDraft, setAmountDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    setAmountDraft((prev) => {
      const next: Record<string, string> = {};
      for (const line of lines) {
        next[line.id] =
          prev[line.id] !== undefined
            ? prev[line.id]
            : Number.isFinite(line.amount) && line.amount !== 0
              ? String(line.amount)
              : '';
      }
      return next;
    });
  }, [lines]);

  const cost = sumCostLines(lines);
  const sell = parseMoney(sellPrice);
  const figures = itemCostFigures({
    sellPrice: sell,
    cost: lines.some((l) => l.label.trim() || l.amount) ? cost : null,
    onHand,
  });
  const money = (n: number | null) =>
    n == null ? '—' : formatCostMoney(n, currency);

  function patchLine(id: string, patch: Partial<ItemCostLine>) {
    onChangeLines(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  return (
    <div className="space-y-4">
      <Field
        label={t('stockPanel.costBreakdown')}
        hint={t('stockPanel.costBreakdownHint')}
      >
        <div className="space-y-2">
          {lines.map((line, idx) => (
            <div key={line.id} className="flex items-center gap-2">
              <Input
                className="min-w-0 flex-1 text-[13px]"
                placeholder={
                  idx === 0
                    ? t('stockPanel.costLinePurchase')
                    : t('stockPanel.costLineOther')
                }
                value={line.label}
                disabled={disabled}
                onChange={(e) => patchLine(line.id, { label: e.target.value })}
              />
              <Input
                className="w-[7.5rem] shrink-0 text-[13px]"
                inputMode="decimal"
                placeholder="0"
                value={amountDraft[line.id] ?? ''}
                disabled={disabled}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9.,]/g, '');
                  setAmountDraft((prev) => ({ ...prev, [line.id]: raw }));
                  patchLine(line.id, { amount: parseMoney(raw) });
                }}
              />
              <IconButton
                label={t('stockPanel.removeCostLine')}
                icon={<IconTrash />}
                disabled={disabled || lines.length <= 1}
                onClick={() =>
                  onChangeLines(lines.filter((l) => l.id !== line.id))
                }
              />
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={<IconPlus />}
            disabled={disabled}
            onClick={() => onChangeLines([...lines, emptyCostLine()])}
          >
            {t('stockPanel.addCostLine')}
          </Button>
        </div>
      </Field>

      {showSellPrice ? (
        <Field
          label={t('stockPanel.sellPrice')}
          hint={
            onSellPriceChange
              ? t('stockPanel.sellPriceHint')
              : t('stockPanel.sellPriceLockedHint')
          }
        >
          <Input
            inputMode="decimal"
            placeholder="0"
            value={sellPrice}
            disabled={disabled || !onSellPriceChange}
            readOnly={!onSellPriceChange}
            onChange={(e) =>
              onSellPriceChange?.(e.target.value.replace(/[^0-9.,]/g, ''))
            }
          />
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <CostStat
          label={t('stockPanel.unitCost')}
          value={money(figures.cost)}
        />
        <CostStat
          label={t('stockPanel.unitProfit')}
          value={money(figures.profit)}
          className={marginClassName(figures.marginPct, figures.profit)}
        />
        <CostStat
          label={t('stockPanel.margin')}
          value={formatMarginPct(figures.marginPct)}
          className={marginClassName(figures.marginPct, figures.profit)}
        />
        <CostStat
          label={t('stockPanel.markup')}
          value={formatMarginPct(figures.markupPct)}
        />
        {onHand != null && Number.isFinite(onHand) ? (
          <>
            <CostStat
              label={t('stockPanel.stockValue')}
              value={money(figures.stockValue)}
            />
            <CostStat
              label={t('stockPanel.stockProfit')}
              value={money(figures.stockProfit)}
              className={marginClassName(figures.marginPct, figures.profit)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function CostStat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/3 px-3 py-2">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-[14px] font-semibold tabular-nums',
          className,
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function ItemCostModal({
  open,
  onClose,
  itemName,
  sellPrice,
  costPrice,
  costBreakdown,
  onHand,
  currency,
  disabled,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  itemName: string;
  sellPrice: number;
  costPrice?: number | null;
  costBreakdown?: unknown;
  onHand?: number | null;
  currency: string;
  disabled?: boolean;
  onSave: (next: {
    costPrice: number | null;
    costBreakdown: ItemCostLine[] | null;
  }) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<ItemCostLine[]>(() =>
    seedCostLines(costPrice, costBreakdown),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLines(seedCostLines(costPrice, costBreakdown));
  }, [open, sellPrice, costPrice, costBreakdown]);

  const canSave = !disabled && !saving;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('stockPanel.costTitle', { name: itemName })}
      description={t('stockPanel.costDescription')}
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!canSave}
            onClick={async () => {
              setSaving(true);
              try {
                const payload = costWritePayload(lines);
                await onSave({
                  costPrice: payload.costPrice,
                  costBreakdown: payload.costBreakdown,
                });
                onClose();
              } finally {
                setSaving(false);
              }
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <ItemCostFields
        sellPrice={String(sellPrice ?? '')}
        lines={lines}
        onChangeLines={setLines}
        onHand={onHand}
        currency={currency}
        disabled={disabled || saving}
      />
    </Modal>
  );
}
