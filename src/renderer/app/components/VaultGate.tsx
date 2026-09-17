import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../../components/BrandMark';
import { PageSpinner } from '../../components/PageSpinner';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';

type VaultState = 'disabled' | 'setup' | 'locked' | 'open' | 'broken';

function isPosHostVault(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.api?.vault) &&
    !(window as any).__BROWSER_CLIENT__ &&
    !(window as any).__KDS_APP__ &&
    !(window as any).__ADMIN_APP__
  );
}

export function VaultGate({ children }: { children: React.ReactNode }) {
  const host = isPosHostVault();
  const { t } = useTranslation();
  const [state, setState] = useState<VaultState | null>(
    host ? null : 'disabled',
  );
  const [hasPassphrase, setHasPassphrase] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secret, setSecret] = useState('');
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [wroteItDown, setWroteItDown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void window.api
      .vault!.getStatus()
      .then((s) => {
        if (!cancelled) {
          setState(s?.state || 'disabled');
          setHasPassphrase(s?.hasPassphrase !== false);
          if (s?.recoveryKey) setRecoveryKey(s.recoveryKey);
          if (s?.state === 'locked' && s?.hasPassphrase === false) {
            setUseRecovery(true);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setState('disabled');
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (!host || state === 'disabled' || (state === 'open' && !recoveryKey)) {
    if (host && state === null) {
      return <PageSpinner message={t('common.loading')} />;
    }
    return <>{children}</>;
  }

  const errorText =
    error &&
    t(`vault.errors.${error}`, { defaultValue: t('vault.errors.generic') });

  async function onSetup() {
    if (passphrase !== confirm) {
      setError('mismatch');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.vault!.setup({ passphrase });
      if (!r.ok) {
        if (r.error === 'already_setup') {
          const unlocked = await window.api.vault!.unlock({
            secret: passphrase,
          });
          if (unlocked.ok) {
            setState('open');
            return;
          }
          setError(unlocked.error || 'already_setup');
          setState('locked');
          setHasPassphrase(true);
          setSecret(passphrase);
          return;
        }
        setError(r.error || 'generic');
        return;
      }
      setRecoveryKey(r.recoveryKey || '');
    } catch {
      setError('generic');
    } finally {
      setBusy(false);
    }
  }

  async function onUnlock() {
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.vault!.unlock({ secret });
      if (!r.ok) {
        setError(
          !hasPassphrase && !useRecovery
            ? 'no_passphrase'
            : r.error || 'generic',
        );
        return;
      }
      setState('open');
    } catch (e) {
      const msg = String((e as { message?: string })?.message || e || '');
      setError(msg.includes('rate_limited') ? 'rate_limited' : 'generic');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto pos-app pos-app--auth text-gray-100">
      <div className="mx-auto flex min-h-full w-full max-w-lg items-start justify-center px-3 py-4 pt-16 sm:max-w-md sm:items-center sm:px-4 sm:py-8 sm:pt-8">
        <div className="w-full min-w-0 rounded-lg pos-surface-panel p-4 sm:p-5 space-y-4">
          <BrandMark size="md" />

          {state === 'broken' ? (
            <>
              <h1 className="text-base font-semibold">
                {t('vault.brokenTitle')}
              </h1>
              <p className="text-[13px] text-gray-400">
                {t('vault.brokenBody')}
              </p>
            </>
          ) : null}

          {state === 'setup' && !recoveryKey ? (
            <>
              <h1 className="text-base font-semibold">
                {t('vault.setupTitle')}
              </h1>
              <p className="text-[13px] text-gray-400">
                {t('vault.setupBody')}
              </p>
              <Field label={t('vault.passphrase')} error={errorText}>
                <Input
                  type="password"
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onSetup();
                  }}
                />
              </Field>
              <Field label={t('vault.confirm')}>
                <Input
                  type="password"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onSetup();
                  }}
                />
              </Field>
              <p className="text-[12px] text-gray-500">
                {t('vault.setupHint')}
              </p>
              <Button
                variant="primary"
                block
                loading={busy}
                disabled={busy}
                onClick={() => void onSetup()}
              >
                {t('vault.create')}
              </Button>
            </>
          ) : null}

          {recoveryKey ? (
            <>
              <h1 className="text-base font-semibold">
                {t('vault.recoveryTitle')}
              </h1>
              <p className="text-[13px] text-gray-400">
                {t('vault.recoveryBody')}
              </p>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-gray-950/50 px-3 py-2 text-[13px] tracking-wide">
                {recoveryKey}
              </pre>
              <label className="flex items-start gap-2 text-[13px] text-gray-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={wroteItDown}
                  onChange={(e) => setWroteItDown(e.target.checked)}
                />
                {t('vault.wroteItDown')}
              </label>
              <Button
                variant="primary"
                block
                disabled={!wroteItDown}
                onClick={() => {
                  void window.api.vault?.ackRecovery?.();
                  setRecoveryKey(null);
                  setState('open');
                }}
              >
                {t('vault.continue')}
              </Button>
            </>
          ) : null}

          {state === 'locked' ? (
            <>
              <h1 className="text-base font-semibold">
                {t('vault.unlockTitle')}
              </h1>
              <p className="text-[13px] text-gray-400">
                {useRecovery || !hasPassphrase
                  ? t('vault.unlockRecoveryBody')
                  : t('vault.unlockBody')}
              </p>
              <Field
                label={
                  useRecovery || !hasPassphrase
                    ? t('vault.recoveryKey')
                    : t('vault.passphrase')
                }
                error={errorText}
              >
                <Input
                  type={useRecovery || !hasPassphrase ? 'text' : 'password'}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onUnlock();
                  }}
                />
              </Field>
              {hasPassphrase ? (
                <button
                  type="button"
                  className="text-[12px] text-gray-400 hover:text-gray-100"
                  onClick={() => {
                    setUseRecovery((v) => !v);
                    setSecret('');
                    setError(null);
                  }}
                >
                  {useRecovery
                    ? t('vault.usePassphrase')
                    : t('vault.useRecovery')}
                </button>
              ) : null}
              <Button
                variant="primary"
                block
                loading={busy}
                disabled={busy || !secret.trim()}
                onClick={() => void onUnlock()}
              >
                {t('vault.unlock')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
