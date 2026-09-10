import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FiscalSaleDTO } from '@shared/ipc';
import { Badge, Button, Field, Input } from '../../components/ui';
import { toast } from '../../stores/toasts';

function fmtAmount(n: number): string {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

/**
 * Fiscal identifiers and the reversal form for a settled ticket.
 *
 * Reason + manager PIN are required on every write: an unlocked admin
 * window on the counter is not authority to void an invoice.
 */
export function TicketSalePanel({
  sale,
  onCorrected,
}: {
  sale: FiscalSaleDTO | null | undefined;
  onCorrected?: () => void;
}) {
  const { t } = useTranslation();
  const [openForm, setOpenForm] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState<'CANCEL' | 'CORRECTIVE' | null>(null);
  const [busy, setBusy] = useState(false);

  const canCorrect = Boolean(window.api.admin.correctSale);

  if (!sale) {
    return (
      <p className="text-[12px] leading-relaxed text-gray-400">
        {t('fiscal.salesNoOrder')}
      </p>
    );
  }

  const voided = sale.status.toUpperCase() === 'VOID';
  const live = sale.items.filter((it) => !it.voided);

  const resetForm = () => {
    setOpenForm(false);
    setPicked([]);
    setReason('');
    setPin('');
    setPending(null);
  };

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const approval = await window.api.auth.verifyManagerPin(pin);
      if (!approval?.ok || !approval.userId) {
        toast.error(t('fiscal.salesBadPin'));
        return;
      }
      const result = await window.api.admin.correctSale?.({
        orderId: sale.orderId,
        kind: pending,
        ...(pending === 'CORRECTIVE' ? { itemIds: picked } : {}),
        reason: reason.trim(),
        approvedByAdminId: approval.userId,
        approvedByAdminToken: approval.approvalToken,
      });
      if (!result?.ok) {
        toast.error(t('fiscal.salesFailed', { error: result?.error || '' }));
        return;
      }
      toast.success(
        result.needsFiling
          ? t('fiscal.salesDoneNeedsFiling')
          : t('fiscal.salesDone'),
      );
      resetForm();
      onCorrected?.();
    } catch (e: any) {
      toast.error(String(e?.message || t('fiscal.salesFailed', { error: '' })));
    } finally {
      setBusy(false);
      setPin('');
    }
  };

  return (
    <div className="space-y-3 text-[12px]">
      <p className="leading-relaxed text-gray-400">{t('fiscal.salesHelp')}</p>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {sale.userName ? (
          <div>
            <dt className="text-gray-500">{t('common.waiter')}</dt>
            <dd className="text-gray-200">{sale.userName}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-gray-500">{t('fiscal.salesClosed')}</dt>
          <dd className="tabular text-gray-200">
            {sale.closedAt ? new Date(sale.closedAt).toLocaleString() : '—'}
          </dd>
        </div>
        {sale.method ? (
          <div>
            <dt className="text-gray-500">{t('fiscal.salesMethod')}</dt>
            <dd className="text-gray-200">{sale.method}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-gray-500">{t('common.total')}</dt>
          <dd className="tabular text-gray-200">{fmtAmount(sale.total)}</dd>
        </div>
      </dl>

      {sale.fiscalNivf || sale.fiscalNslf ? (
        <div className="space-y-1 font-mono break-all text-gray-300">
          {sale.fiscalNivf ? (
            <div>
              {t('fiscal.salesNivf')}: {sale.fiscalNivf}
            </div>
          ) : null}
          {sale.fiscalNslf ? (
            <div>
              {t('fiscal.salesNslf')}: {sale.fiscalNslf}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-gray-500">{t('fiscal.salesNotFiscalized')}</p>
      )}

      {voided ? <Badge tone="danger">{t('fiscal.salesVoided')}</Badge> : null}

      {sale.corrections.length > 0 ? (
        <div className="space-y-1 text-gray-400">
          {sale.corrections.map((c) => (
            <div key={c.id}>
              {c.kind === 'CANCEL'
                ? t('fiscal.salesCancelled')
                : t('fiscal.salesCorrected')}
              {' · '}
              {fmtAmount(c.amountDelta)}
              {' · '}
              {c.reason}
              {c.filedAt ? '' : ` · ${t('fiscal.salesAwaitingFiling')}`}
            </div>
          ))}
        </div>
      ) : null}

      {voided || !canCorrect ? null : openForm ? (
        <div className="space-y-3 border-t border-white/7 pt-3">
          <div className="space-y-1.5">
            {live.map((it) => (
              <label
                key={it.id}
                className="flex items-center gap-2 text-gray-200"
              >
                <input
                  type="checkbox"
                  checked={picked.includes(it.id)}
                  onChange={(e) =>
                    setPicked((prev) =>
                      e.target.checked
                        ? [...prev, it.id]
                        : prev.filter((id) => id !== it.id),
                    )
                  }
                />
                <span className="min-w-0 truncate">
                  {it.qty} × {it.name}
                </span>
                <span className="tabular ml-auto shrink-0 text-gray-400">
                  {fmtAmount(it.qty * it.unitPrice)}
                </span>
              </label>
            ))}
          </div>
          <Field label={t('fiscal.salesReason')}>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('fiscal.salesReasonHint')}
            />
          </Field>
          {pending ? (
            <div className="space-y-2 rounded-lg border border-white/7 bg-gray-900/50 p-3">
              <p className="text-gray-300">
                {pending === 'CANCEL'
                  ? t('fiscal.salesConfirmCancel', {
                      total: fmtAmount(sale.total),
                    })
                  : t('fiscal.salesConfirmCorrective', {
                      count: picked.length,
                    })}
              </p>
              <Field label={t('fiscal.salesPin')}>
                <Input
                  type="password"
                  autoFocus
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit();
                  }}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy || !pin.trim()}
                  loading={busy}
                  onClick={() => void submit()}
                >
                  {t('fiscal.salesConfirm')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setPending(null);
                    setPin('');
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={busy || reason.trim().length < 3}
                title={t('fiscal.salesCancelHelp')}
                onClick={() => setPending('CANCEL')}
              >
                {t('fiscal.salesCancelAction')}
              </Button>
              <Button
                size="sm"
                disabled={
                  busy ||
                  reason.trim().length < 3 ||
                  picked.length === 0 ||
                  picked.length === live.length
                }
                title={
                  picked.length === live.length && picked.length > 0
                    ? t('fiscal.salesUseCancel')
                    : t('fiscal.salesCorrectiveHelp')
                }
                onClick={() => setPending('CORRECTIVE')}
              >
                {t('fiscal.salesCorrectiveAction')}
              </Button>
              <Button size="sm" disabled={busy} onClick={resetForm}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <Button size="sm" onClick={() => setOpenForm(true)}>
          {t('fiscal.salesReverse')}
        </Button>
      )}
    </div>
  );
}
