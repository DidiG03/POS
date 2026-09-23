import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { SpinnerGlyph } from '../../components/SpinnerGlyph';
import {
  IconCard,
  IconCash,
  IconChevronLeft,
  IconPrinter,
} from '../../components/icons';
import { formatEur } from '../../utils/format';

type PayLine = {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
  note?: string;
};

type SeatPayRow = {
  id: string;
  label: string;
  paid: boolean;
  gross: number;
};

type ServiceChargeCfg = {
  enabled: boolean;
  mode: 'PERCENT' | 'AMOUNT';
  value: number;
};

export function PaymentCheckout({
  open,
  busy,
  busyMessage,
  busyDetail,
  hasTables,
  tableLabel,
  saleLabel,
  coversKnown,
  addMode,
  payingSeatName,
  seatPayRows,
  paySeatId,
  onPaySeat,
  remainingSeats,
  payLines,
  totals,
  serviceChargeCfg,
  serviceChargeAmount,
  applyServiceCharge,
  onApplyServiceCharge,
  discountAmount,
  discountType,
  discountValue,
  discountReason,
  onDiscountType,
  onDiscountValue,
  onDiscountReason,
  totalDue,
  eurDue,
  eurExchangeRate,
  splitGuestCount,
  onSplitGuestCount,
  split,
  eurPerPerson,
  paymentMethod,
  onPaymentMethod,
  formatAmount,
  posCurrency,
  printReceipt,
  onTogglePrint,
  managerPinHint,
  confirmDisabled,
  confirmLabel,
  confirmEur,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  busyMessage: string;
  busyDetail: string;
  hasTables: boolean;
  tableLabel: string;
  saleLabel: string;
  coversKnown: number | null | undefined;
  addMode: string;
  payingSeatName: string | null;
  seatPayRows: SeatPayRow[];
  paySeatId: string | null;
  onPaySeat: (id: string) => void;
  remainingSeats: number;
  payLines: PayLine[];
  totals: { total: number };
  serviceChargeCfg: ServiceChargeCfg;
  serviceChargeAmount: number;
  applyServiceCharge: boolean;
  onApplyServiceCharge: (next: boolean) => void;
  discountAmount: number;
  discountType: 'NONE' | 'PERCENT' | 'AMOUNT';
  discountValue: string;
  discountReason: string;
  onDiscountType: (next: 'NONE' | 'PERCENT' | 'AMOUNT') => void;
  onDiscountValue: (next: string) => void;
  onDiscountReason: (next: string) => void;
  totalDue: number;
  eurDue: number | null;
  eurExchangeRate: number | null;
  splitGuestCount: number;
  onSplitGuestCount: (next: number) => void;
  split: { guests: number; perPerson: number; lastPerson: number } | null;
  eurPerPerson: number | null;
  paymentMethod: 'CASH' | 'CARD' | 'GIFT_CARD' | 'ROOM_CHARGE';
  onPaymentMethod: (next: 'CASH' | 'CARD') => void;
  formatAmount: (n: number) => string;
  posCurrency: string;
  printReceipt: boolean;
  onTogglePrint: () => void;
  managerPinHint: boolean;
  confirmDisabled: boolean;
  confirmLabel: string;
  confirmEur: number | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [itemsOpen, setItemsOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setItemsOpen(false);
    setDiscountOpen(discountAmount > 0);
  }, [open]);

  useEffect(() => {
    if (discountAmount > 0) setDiscountOpen(true);
  }, [discountAmount]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, busy, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const discountAmountLabel =
    String(posCurrency || '').toUpperCase() === 'EUR'
      ? '€'
      : String(posCurrency || '').toUpperCase() === 'ALL' ||
          String(posCurrency || '').toUpperCase() === 'LEK'
        ? 'L'
        : String(posCurrency || '€').slice(0, 1);

  return createPortal(
    <div
      className="pos-pay-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-pay-title"
    >
      <header className="pos-pay-header">
        <button
          type="button"
          className="pos-pay-back"
          disabled={busy}
          onClick={onClose}
        >
          <IconChevronLeft />
          <span>{t('common.back')}</span>
        </button>
        <div className="ml-auto min-w-0 shrink text-right">
          <h1 id="pos-pay-title" className="pos-pay-title">
            {t('order.payment')}
          </h1>
          <p className="pos-pay-kicker">
            {hasTables ? `${t('common.table')} ${tableLabel}` : saleLabel}
            {hasTables && typeof coversKnown === 'number'
              ? ` · ${t('common.coversWithVal', { val: coversKnown })}`
              : null}
            {addMode === 'seat' && payingSeatName
              ? ` · ${payingSeatName}`
              : null}
          </p>
        </div>
      </header>

      {busy ? (
        <div className="pos-pay-busy" role="status" aria-live="assertive">
          <SpinnerGlyph className="size-6 text-[color:var(--pos-fg-muted)]" />
          <div className="text-sm font-medium">{busyMessage}</div>
          <div className="text-xs text-[color:var(--pos-fg-muted)]">
            {busyDetail}
          </div>
        </div>
      ) : null}

      <div className="pos-pay-body">
        <div className="pos-pay-inner space-y-3">
          <section className="pos-pay-hero">
            <div className="text-[13px] text-[color:var(--pos-fg-muted)]">
              {t('common.total')}
            </div>
            <div className="pos-pay-hero-amount tabular-nums">
              {formatAmount(totalDue)}
            </div>
            <PaymentFxHint
              eurAmount={eurDue}
              eurExchangeRate={eurExchangeRate}
              showRate
            />
            {totals.total !== totalDue || serviceChargeAmount > 0 ? (
              <div className="pos-pay-hero-breakdown">
                <span>
                  {t('common.subtotal')} {formatAmount(totals.total)}
                </span>
                {serviceChargeCfg.enabled && serviceChargeAmount > 0 ? (
                  <span>
                    {t('common.serviceCharge')} +{' '}
                    {formatAmount(serviceChargeAmount)}
                  </span>
                ) : null}
                {discountAmount > 0 ? (
                  <span>
                    {t('common.discount')} −{formatAmount(discountAmount)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>

          {addMode === 'seat' ? (
            <section>
              <div className="pos-pay-label">
                {t('order.selectGuestsPayment')}
              </div>
              <div className="flex flex-wrap gap-2">
                {seatPayRows.map((row) => {
                  const active = paySeatId === row.id;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      disabled={row.paid || busy}
                      onClick={() => onPaySeat(row.id)}
                      className={`pos-pay-seat ${
                        row.paid
                          ? 'opacity-40'
                          : active
                            ? 'pos-pay-seat--active'
                            : ''
                      }`}
                    >
                      <span className="truncate font-semibold">
                        {row.label}
                      </span>
                      <span className="tabular-nums text-[12px] opacity-80">
                        {row.paid
                          ? t('order.seatPaid')
                          : formatAmount(row.gross)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {remainingSeats > 1 ? (
                <div className="mt-1.5 text-[12px] text-[color:var(--pos-fg-muted)]">
                  {t('order.remainingSeats', { count: remainingSeats })}
                </div>
              ) : null}
            </section>
          ) : null}

          <section>
            <div className="pos-pay-label">{t('order.paymentMethods')}</div>
            <div className="grid grid-cols-2 gap-2">
              <PayMethodTile
                active={paymentMethod === 'CASH'}
                label={t('order.cash')}
                onClick={() => onPaymentMethod('CASH')}
              >
                <IconCash />
              </PayMethodTile>
              <PayMethodTile
                active={paymentMethod === 'CARD'}
                label={t('order.card')}
                onClick={() => onPaymentMethod('CARD')}
              >
                <IconCard />
              </PayMethodTile>
            </div>
          </section>

          {addMode !== 'seat' ? (
            <section className="pos-pay-card flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold">
                  {t('order.splitBill')}
                </div>
                {split ? (
                  <div className="mt-0.5 text-[12px] text-[color:var(--pos-fg-muted)]">
                    {split.guests > 1 &&
                    Math.abs(split.lastPerson - split.perPerson) > 0.001
                      ? t('order.perPersonLast', {
                          amount: formatAmount(split.perPerson),
                          last: formatAmount(split.lastPerson),
                        })
                      : t('order.perPerson', {
                          amount: formatAmount(split.perPerson),
                        })}
                    {eurPerPerson != null ? (
                      <span className="pos-pay-fx ml-1">
                        {t('order.inEur', { amount: formatEur(eurPerPerson) })}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  className="pos-pay-stepper"
                  disabled={splitGuestCount <= 1}
                  onClick={() =>
                    onSplitGuestCount(Math.max(1, splitGuestCount - 1))
                  }
                  aria-label="−"
                >
                  −
                </button>
                <div className="min-w-[1.75rem] text-center text-[15px] font-semibold tabular-nums">
                  {splitGuestCount}
                </div>
                <button
                  type="button"
                  className="pos-pay-stepper"
                  disabled={splitGuestCount >= 30}
                  onClick={() =>
                    onSplitGuestCount(Math.min(30, splitGuestCount + 1))
                  }
                  aria-label="+"
                >
                  +
                </button>
              </div>
            </section>
          ) : null}

          <details
            className="pos-pay-card"
            open={itemsOpen}
            onToggle={(e) => setItemsOpen(e.currentTarget.open)}
          >
            <summary className="pos-pay-summary">
              {t('order.billItems', { count: payLines.length })}
            </summary>
            <div className="mt-2 space-y-1.5">
              {payLines.length === 0 ? (
                <div className="text-[13px] text-[color:var(--pos-fg-muted)]">
                  {t('common.noItems')}
                </div>
              ) : (
                payLines.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-start justify-between gap-3 text-[13px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate">
                        {l.qty}× {l.name}
                      </div>
                      {l.note ? (
                        <div className="truncate text-[12px] text-[color:var(--pos-fg-muted)]">
                          {l.note}
                        </div>
                      ) : null}
                    </div>
                    <div className="shrink-0 font-medium tabular-nums">
                      {formatAmount(l.qty * l.unitPrice)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </details>

          {serviceChargeCfg.enabled ? (
            <label className="pos-pay-card flex cursor-pointer items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold">
                  {t('common.serviceCharge')}
                </div>
                <div className="text-[12px] text-[color:var(--pos-fg-muted)]">
                  {serviceChargeCfg.mode === 'PERCENT'
                    ? `${serviceChargeCfg.value}%`
                    : formatAmount(serviceChargeCfg.value)}
                </div>
              </div>
              <input
                type="checkbox"
                className="size-5 accent-blue-600"
                checked={applyServiceCharge}
                onChange={(e) => onApplyServiceCharge(e.target.checked)}
              />
            </label>
          ) : null}

          <details
            className="pos-pay-card"
            open={discountOpen}
            onToggle={(e) => setDiscountOpen(e.currentTarget.open)}
          >
            <summary className="pos-pay-summary">
              {t('common.discount')}
              {discountAmount > 0 ? ` · −${formatAmount(discountAmount)}` : ''}
            </summary>
            <div className="mt-2">
              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  className={`pos-pay-chip flex-none px-3 ${
                    discountType === 'PERCENT' ? 'pos-pay-chip--active' : ''
                  }`}
                  onClick={() => onDiscountType('PERCENT')}
                >
                  %
                </button>
                <button
                  type="button"
                  className={`pos-pay-chip flex-none px-3 ${
                    discountType === 'AMOUNT' ? 'pos-pay-chip--active' : ''
                  }`}
                  onClick={() => onDiscountType('AMOUNT')}
                >
                  {discountAmountLabel}
                </button>
                <input
                  className="pos-pay-input flex-1"
                  placeholder={
                    discountType === 'PERCENT'
                      ? t('order.discountPlaceholderPercent')
                      : discountType === 'AMOUNT'
                        ? t('order.discountPlaceholderAmount')
                        : t('order.discountPlaceholderType')
                  }
                  value={discountValue}
                  disabled={discountType === 'NONE'}
                  onChange={(e) => onDiscountValue(e.target.value)}
                />
              </div>
              <input
                className="pos-pay-input"
                placeholder={t('order.discountReason')}
                value={discountReason}
                onChange={(e) => onDiscountReason(e.target.value)}
              />
            </div>
          </details>
        </div>
      </div>

      <footer className="pos-pay-footer">
        <div className="pos-pay-inner">
          {managerPinHint ? (
            <div className="pos-pay-warn mb-2 text-[12px] font-medium">
              {t('order.managerPinPayment')}
            </div>
          ) : null}
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px]">
              <IconPrinter />
              <span>{t('order.printReceipt')}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={printReceipt}
              className={`pos-pay-switch ${printReceipt ? 'pos-pay-switch--on' : ''}`}
              onClick={onTogglePrint}
              aria-label={t('order.togglePrintReceipt')}
            >
              <span aria-hidden className="pos-pay-switch-knob" />
            </button>
          </div>
          <button
            type="button"
            className="pos-pay-confirm"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {busy ? (
              <>
                <SpinnerGlyph className="size-4" />
                <span>{busyMessage}</span>
              </>
            ) : (
              <span className="flex flex-col items-center leading-tight">
                <span>{confirmLabel}</span>
                {confirmEur != null ? (
                  <span className="text-[12px] font-medium opacity-90">
                    {formatEur(confirmEur)}
                  </span>
                ) : null}
              </span>
            )}
          </button>
        </div>
      </footer>
    </div>,
    document.body,
  );
}

function PaymentFxHint({
  eurAmount,
  eurExchangeRate,
  showRate = false,
}: {
  eurAmount: number | null;
  eurExchangeRate: number | null;
  showRate?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-0.5">
      {eurAmount != null ? (
        <div className="pos-pay-fx text-sm font-medium tabular-nums">
          {t('order.inEur', { amount: formatEur(eurAmount) })}
        </div>
      ) : showRate ? (
        <div className="text-[11px] opacity-50">
          {t('order.eurRateMissing')}
        </div>
      ) : null}
      {showRate && eurExchangeRate != null ? (
        <div className="text-[11px] opacity-50">
          {t('order.eurRateHint', { rate: String(eurExchangeRate) })}
        </div>
      ) : null}
    </div>
  );
}

function PayMethodTile({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`pos-pay-method ${active ? 'pos-pay-method--active' : ''}`}
      onClick={onClick}
    >
      <span className="opacity-90">{children}</span>
      <span className="font-semibold">{label}</span>
    </button>
  );
}
