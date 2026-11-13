import { useCallback, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CASH_COUNT_REQUIRED, parseCountedCash } from '@shared/cashCount';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';

type ClockOutResult = any;

/**
 * Clock out, asking for the cash counted when the venue wants a count
 * (`@shared/cashCount`). The expected amount is not shown: it is a blind
 * count, and the shift slip compares the two.
 *
 * Returns the till's answer, or `{ ok: false, cancelled: true }` when the
 * person closed the count without entering it.
 */
export function useCashCountClockOut(): {
  clockOut: (userId: number) => Promise<ClockOutResult>;
  dialog: ReactElement | null;
} {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const pending = useRef<((amount: string | null) => void) | null>(null);

  const ask = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        pending.current = resolve;
        setValue('');
        setInvalid(false);
        setOpen(true);
      }),
    [],
  );

  const finish = (amount: string | null) => {
    setOpen(false);
    const r = pending.current;
    pending.current = null;
    r?.(amount);
  };

  const clockOut = useCallback(
    async (userId: number) => {
      const first: ClockOutResult = await window.api.shifts.clockOut(userId);
      if (
        !(first && first.ok === false && first.code === CASH_COUNT_REQUIRED)
      ) {
        return first;
      }
      const amount = await ask();
      if (amount === null) return { ok: false, cancelled: true };
      return await window.api.shifts.clockOut(userId, { cashCounted: amount });
    },
    [ask],
  );

  const submit = () => {
    if (parseCountedCash(value) === null) {
      setInvalid(true);
      return;
    }
    finish(value);
  };

  const dialog = open ? (
    <Modal
      open
      onClose={() => finish(null)}
      title={t('cashCount.title')}
      description={t('cashCount.help')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit}>
            {t('cashCount.submit')}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        inputMode="decimal"
        value={value}
        invalid={invalid}
        placeholder="0.00"
        aria-label={t('cashCount.title')}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      {invalid ? (
        <p className="mt-2 text-[12px] text-rose-400">
          {t('cashCount.invalid')}
        </p>
      ) : null}
    </Modal>
  ) : null;

  return { clockOut, dialog };
}
