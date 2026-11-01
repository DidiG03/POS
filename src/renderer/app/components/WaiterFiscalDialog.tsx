import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserFiscalResult } from '@shared/ipc';
import { sanitizePinInput } from '@shared/staffPin';
import { Button, Modal, Switch } from '../../components/ui';
import { toast } from '../../stores/toasts';

/**
 * Per-waiter fiskalizimi switch, opened from the sign-in screen by holding a
 * staff name for five seconds. The waiter's PIN unlocks it; the switch then
 * turns fiskalizimi off or on for the payments that waiter takes.
 */
export function WaiterFiscalDialog({
  staff,
  onClose,
}: {
  staff: { id: number; displayName: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pinRef = useRef<HTMLInputElement>(null);
  const [pin, setPin] = useState('');
  const [verifiedPin, setVerifiedPin] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPin('');
    setVerifiedPin(null);
    setEnabled(null);
    setBusy(false);
    if (!staff) return;
    const id = window.requestAnimationFrame(() => pinRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [staff?.id]);

  const call = async (
    pinValue: string,
    next?: boolean,
  ): Promise<UserFiscalResult | null> => {
    if (!staff) return null;
    const manage = window.api.auth.manageUserFiscal;
    if (!manage) {
      toast.error(t('login.waiterFiscal.unavailable'));
      return null;
    }
    try {
      return await manage({
        userId: staff.id,
        pin: pinValue,
        ...(next === undefined ? {} : { enabled: next }),
      });
    } catch (e: any) {
      toast.error(String(e?.message || '') || t('login.waiterFiscal.failed'));
      return null;
    }
  };

  const explain = (r: UserFiscalResult) => {
    if (r.ok) return;
    if (r.code === 'WRONG_PIN') {
      toast.error(t('login.invalidPin'), { title: t('login.wrongPinTitle') });
    } else if (r.code === 'LOCKED') {
      toast.error(t('login.waiterFiscal.locked'));
    } else {
      toast.error(t('login.waiterFiscal.failed'));
    }
  };

  const unlock = async () => {
    if (busy || pin.trim().length < 1) return;
    setBusy(true);
    const r = await call(pin);
    setBusy(false);
    if (!r) return;
    if (!r.ok) {
      explain(r);
      setPin('');
      return;
    }
    setVerifiedPin(pin);
    setEnabled(r.enabled);
  };

  const toggle = async (next: boolean) => {
    if (busy || verifiedPin == null || !staff) return;
    setBusy(true);
    const r = await call(verifiedPin, next);
    setBusy(false);
    if (!r) return;
    if (!r.ok) {
      explain(r);
      return;
    }
    setEnabled(r.enabled);
    toast.success(
      r.enabled
        ? t('login.waiterFiscal.turnedOn', { name: staff.displayName })
        : t('login.waiterFiscal.turnedOff', { name: staff.displayName }),
    );
  };

  return (
    <Modal
      open={Boolean(staff)}
      onClose={onClose}
      size="sm"
      title={t('login.waiterFiscal.title', { name: staff?.displayName || '' })}
      description={
        verifiedPin == null
          ? t('login.waiterFiscal.enterPin', { name: staff?.displayName || '' })
          : undefined
      }
      footer={
        verifiedPin == null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={pin.trim().length < 1}
              onClick={unlock}
            >
              {t('common.confirm')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {t('login.waiterFiscal.done')}
          </Button>
        )
      }
    >
      {verifiedPin == null ? (
        <input
          ref={pinRef}
          type="password"
          inputMode="numeric"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="one-time-code"
          placeholder={t('login.pinPlaceholder')}
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(sanitizePinInput(e.target.value))}
          onKeyDown={(e) => e.key === 'Enter' && unlock()}
          className="pos-input py-3 text-center tracking-[0.55em] tabular"
          style={{ fontSize: '20px' }}
        />
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-gray-100">
              {t('login.waiterFiscal.label')}
            </div>
            <div className="text-[12px] text-[color:var(--pos-fg-muted)]">
              {enabled
                ? t('login.waiterFiscal.onHint')
                : t('login.waiterFiscal.offHint')}
            </div>
          </div>
          <Switch
            checked={enabled === true}
            disabled={busy}
            label={t('login.waiterFiscal.label')}
            onChange={toggle}
          />
        </div>
      )}
    </Modal>
  );
}
