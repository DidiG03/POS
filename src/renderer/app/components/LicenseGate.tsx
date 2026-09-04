import {
  useCallback,
  useEffect,
  useId,
  useState,
  type ComponentProps,
} from 'react';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../../components/BrandMark';
import { Button, Field, Input, cn } from '../../components/ui';
import { IconArrowLeft } from '../../components/icons';
import { toast } from '../../stores/toasts';
import type {
  LicenseEdition,
  LicensePlanQuote,
  LicensePlansDTO,
} from '@shared/ipc';

type LicenseStatus = {
  required: boolean;
  licensed: boolean;
  email?: string;
  key?: string;
  status?: string;
  currentPeriodEnd?: string | null;
  message?: string | null;
  billingConfigured?: boolean;
};

type GateView =
  | 'welcome'
  | 'register'
  | 'business'
  | 'confirm'
  | 'login'
  | 'forgotKey';

type RegisterDraft = {
  name: string;
  email: string;
  phone: string;
  businessName: string;
  edition: LicenseEdition | null;
};

type DetailField = 'name' | 'email' | 'phone' | 'businessName';

const DRAFT_KEY = 'pos_onboarding_draft';
const RESEND_COOLDOWN_SEC = 30;

function emptyDraft(): RegisterDraft {
  return { name: '', email: '', phone: '', businessName: '', edition: null };
}

function loadDraft(): RegisterDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    const j = JSON.parse(raw) as Partial<RegisterDraft>;
    const edition =
      j?.edition === 'STORE' || j?.edition === 'RESTAURANT' ? j.edition : null;
    return {
      name: String(j?.name || ''),
      email: String(j?.email || ''),
      phone: String(j?.phone || ''),
      businessName: String(j?.businessName || ''),
      edition,
    };
  } catch {
    return emptyDraft();
  }
}

function persistDraft(next: RegisterDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
  } catch {
    // quota / private mode
  }
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function detailsErrors(d: RegisterDraft): Partial<Record<DetailField, string>> {
  const out: Partial<Record<DetailField, string>> = {};
  if (d.name.trim().length < 2) out.name = 'license.nameInvalid';
  if (!isEmail(d.email)) out.email = 'license.emailInvalid';
  if (d.phone.replace(/\D/g, '').length < 8) out.phone = 'license.phoneInvalid';
  if (d.businessName.trim().length < 2)
    out.businessName = 'license.businessNameInvalid';
  return out;
}

function isOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

function emptyPlans(): LicensePlansDTO {
  return { restaurant: null, store: null };
}

function recurringPriceLabel(
  t: (key: string, opts?: { price?: string; interval?: string }) => string,
  plan: LicensePlanQuote | null | undefined,
): string {
  if (!plan?.formatted) return '';
  const interval =
    plan.interval === 'year'
      ? t('license.intervalYear')
      : t('license.intervalMonth');
  return t('license.priceRecurring', { price: plan.formatted, interval });
}

export default function LicenseGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const isHost =
    typeof window !== 'undefined' &&
    Boolean((window as any).api?.license) &&
    !(window as any).__BROWSER_CLIENT__ &&
    !(window as any).__KDS_APP__;

  const [status, setStatus] = useState<LicenseStatus | null>(
    isHost ? null : { required: false, licensed: true },
  );
  const [view, setView] = useState<GateView>('welcome');
  const [draft, setDraft] = useState<RegisterDraft>(emptyDraft);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [keyEmailed, setKeyEmailed] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [plans, setPlans] = useState<LicensePlansDTO>(emptyPlans);

  const fail = useCallback(
    (message: string, detail?: string) => {
      toast.error(message, {
        title: t('license.errorTitle'),
        detail,
      });
    },
    [t],
  );

  const refresh = useCallback(async () => {
    if (!isHost) return;
    try {
      const s = await window.api.license.getStatus();
      setStatus(s);
      if (s?.email) {
        setDraft((prev) => {
          if (prev.email) return prev;
          const next = { ...prev, email: String(s.email) };
          persistDraft(next);
          return next;
        });
      }
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e || '');
      toast.fromError(e, t('license.statusFailed'), {
        title: t('license.errorTitle'),
      });
      setStatus({
        required: true,
        licensed: false,
        billingConfigured: true,
        message: detail || t('license.statusFailed'),
      });
    }
  }, [isHost, t]);

  useEffect(() => {
    if (!isHost) return;
    setDraft(loadDraft());
    void window.api.license
      .getPlans()
      .then((p) => {
        if (p?.restaurant || p?.store) setPlans(p);
      })
      .catch(() => {
        // prices stay hidden if billing is unreachable
      });
  }, [isHost]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isHost) return;
    const off = window.api.license.onUpdated?.(() => {
      void refresh();
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [isHost, refresh]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const id = window.setTimeout(() => {
      setResendIn((s) => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearTimeout(id);
  }, [resendIn]);

  if (!isHost) return <>{children}</>;
  if (!status) {
    return (
      <div className="flex h-full items-center justify-center px-4 pos-app pos-app--auth text-gray-200">
        {t('common.loading')}
      </div>
    );
  }
  if (!status.required || status.licensed) return <>{children}</>;

  function patchDraft(part: Partial<RegisterDraft>) {
    setDraft((prev) => {
      const next = { ...prev, ...part };
      persistDraft(next);
      return next;
    });
  }

  function goTo(next: GateView) {
    setShowFieldErrors(false);
    setView(next);
  }

  function goBack() {
    setShowFieldErrors(false);
    if (view === 'login' || view === 'register') setView('welcome');
    else if (view === 'forgotKey') setView('login');
    else if (view === 'business') setView('register');
    else if (view === 'confirm') setView('business');
  }

  function continueFromDetails() {
    const issues = detailsErrors(draft);
    if (Object.keys(issues).length) {
      setShowFieldErrors(true);
      fail(t('license.fixFields'));
      return;
    }
    goTo('business');
  }

  function continueFromBusiness() {
    if (!draft.edition) {
      setShowFieldErrors(true);
      fail(t('license.pickBusiness'));
      return;
    }
    goTo('confirm');
  }

  async function subscribe() {
    if (busy) return;
    const issues = detailsErrors(draft);
    if (Object.keys(issues).length || !draft.edition) {
      setShowFieldErrors(true);
      fail(!draft.edition ? t('license.pickBusiness') : t('license.fixFields'));
      return;
    }
    if (isOffline()) {
      fail(t('license.offline'));
      return;
    }
    setBusy('pay');
    try {
      const r = await window.api.license.createCheckout({
        email: draft.email.trim(),
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        businessName: draft.businessName.trim(),
        edition: draft.edition,
      });
      if (r?.error) {
        fail(String(r.error));
        return;
      }
      if (r?.alreadyLicensed) {
        toast.success(t('license.keySent', { email: draft.email.trim() }));
        setKeyEmailed(true);
        setResendIn(RESEND_COOLDOWN_SEC);
        goTo('login');
        return;
      }
      if (r?.url) {
        toast.success(t('license.payOpened'));
        return;
      }
      fail(t('license.payFailed'));
    } catch (e: unknown) {
      toast.fromError(e, t('license.payFailed'), {
        title: t('license.errorTitle'),
      });
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    if (busy) return;
    if (key.trim().length < 8) {
      fail(t('license.keyTooShort'));
      return;
    }
    if (isOffline()) {
      fail(t('license.offline'));
      return;
    }
    setBusy('key');
    try {
      const r = await window.api.license.activateKey({
        key: key.trim(),
      });
      if (!r?.ok) {
        fail(String(r?.error || t('license.keyInvalid')));
        return;
      }
      await refresh();
    } catch (e: unknown) {
      toast.fromError(e, t('license.keyInvalid'), {
        title: t('license.errorTitle'),
      });
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    if (busy || resendIn > 0) return;
    if (!isEmail(draft.email)) {
      setShowFieldErrors(true);
      fail(t('license.loginEmailInvalid'));
      return;
    }
    if (isOffline()) {
      fail(t('license.offline'));
      return;
    }
    setBusy('restore');
    try {
      const r = await window.api.license.restore({
        email: draft.email.trim(),
      });
      if (!r?.ok) {
        fail(String(r?.error || r?.message || t('license.restoreFailed')));
        return;
      }
      toast.success(t('license.keySent', { email: draft.email.trim() }));
      setKeyEmailed(true);
      setResendIn(RESEND_COOLDOWN_SEC);
    } catch (e: unknown) {
      toast.fromError(e, t('license.restoreFailed'), {
        title: t('license.errorTitle'),
      });
    } finally {
      setBusy(null);
    }
  }

  const fieldErrors = showFieldErrors ? detailsErrors(draft) : {};
  const billingMissing = status.billingConfigured === false;

  return (
    <div className="h-full min-h-0 overflow-y-auto pos-app pos-app--auth text-gray-100">
      <div className="mx-auto flex min-h-full w-full max-w-lg items-start justify-center px-3 py-4 pt-16 sm:max-w-md sm:items-center sm:px-4 sm:py-8 sm:pt-8">
        <div className="w-full min-w-0 rounded-lg pos-surface-panel p-4 sm:p-5 space-y-4">
          {view !== 'welcome' ? (
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-gray-400 hover:text-gray-100"
              onClick={goBack}
            >
              <IconArrowLeft className="size-4" />
              {t('common.back')}
            </button>
          ) : null}

          <BrandMark size="md" />

          {billingMissing ? (
            <div className="rounded-md border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-[13px] text-amber-200">
              {status.message || t('license.billingMissing')}
            </div>
          ) : null}

          {view === 'welcome' ? (
            <Welcome
              onRegister={() => goTo('register')}
              onLogin={() => goTo('login')}
            />
          ) : null}

          {view === 'register' ? (
            <RegisterDetails
              draft={draft}
              errors={fieldErrors}
              onChange={patchDraft}
              onContinue={continueFromDetails}
            />
          ) : null}

          {view === 'business' ? (
            <BusinessChoice
              edition={draft.edition}
              invalid={showFieldErrors && !draft.edition}
              restaurantPrice={recurringPriceLabel(t, plans.restaurant)}
              storePrice={recurringPriceLabel(t, plans.store)}
              onPick={(edition) => {
                setShowFieldErrors(false);
                patchDraft({ edition });
              }}
              onContinue={continueFromBusiness}
            />
          ) : null}

          {view === 'confirm' ? (
            <ConfirmPay
              draft={draft}
              busy={busy}
              priceLabel={recurringPriceLabel(
                t,
                draft.edition === 'STORE' ? plans.store : plans.restaurant,
              )}
              onPay={() => void subscribe()}
            />
          ) : null}

          {view === 'login' ? (
            <LoginKeyForm
              licenseKey={key}
              busy={busy}
              onKey={setKey}
              onActivate={() => void activate()}
              onForgot={() => goTo('forgotKey')}
            />
          ) : null}

          {view === 'forgotKey' ? (
            <ForgotKeyForm
              email={draft.email}
              busy={busy}
              keyEmailed={keyEmailed}
              resendIn={resendIn}
              emailError={
                showFieldErrors && !isEmail(draft.email)
                  ? t('license.loginEmailInvalid')
                  : undefined
              }
              onEmail={(email) => patchDraft({ email })}
              onSend={() => void restore()}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Welcome({
  onRegister,
  onLogin,
}: {
  onRegister: () => void;
  onLogin: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div>
        <div className="text-[18px] font-semibold tracking-tight sm:text-lg">
          {t('license.welcomeTitle')}
        </div>
        <div className="mt-1 text-sm text-gray-400">
          {t('license.welcomeBody')}
        </div>
      </div>
      <div className="flex flex-col gap-2 pt-1">
        <Button variant="primary" block size="lg" onClick={onRegister}>
          {t('license.register')}
        </Button>
        <Button variant="secondary" block size="lg" onClick={onLogin}>
          {t('license.alreadyCustomer')}
        </Button>
      </div>
    </>
  );
}

function RegisterDetails({
  draft,
  errors,
  onChange,
  onContinue,
}: {
  draft: RegisterDraft;
  errors: Partial<Record<DetailField, string>>;
  onChange: (part: Partial<RegisterDraft>) => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div>
        <div className="text-[18px] font-semibold tracking-tight sm:text-lg">
          {t('license.registerTitle')}
        </div>
        <div className="mt-1 text-sm text-gray-400">
          {t('license.registerBody')}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2">
        <GateInput
          className="min-[480px]:col-span-2"
          label={t('license.name')}
          autoComplete="name"
          value={draft.name}
          error={errors.name ? t(errors.name) : undefined}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t('license.namePlaceholder')}
        />
        <GateInput
          className="min-[480px]:col-span-2"
          label={t('license.email')}
          type="email"
          autoComplete="email"
          value={draft.email}
          error={errors.email ? t(errors.email) : undefined}
          onChange={(e) => onChange({ email: e.target.value })}
          placeholder="you@business.com"
        />
        <GateInput
          label={t('license.phone')}
          type="tel"
          autoComplete="tel"
          value={draft.phone}
          error={errors.phone ? t(errors.phone) : undefined}
          onChange={(e) => onChange({ phone: e.target.value })}
          placeholder={t('license.phonePlaceholder')}
        />
        <GateInput
          label={t('license.businessName')}
          autoComplete="organization"
          value={draft.businessName}
          error={errors.businessName ? t(errors.businessName) : undefined}
          onChange={(e) => onChange({ businessName: e.target.value })}
          placeholder={t('license.businessNamePlaceholder')}
        />
      </div>
      <Button variant="primary" block size="lg" onClick={onContinue}>
        {t('license.continue')}
      </Button>
    </>
  );
}

function BusinessChoice({
  edition,
  invalid,
  restaurantPrice,
  storePrice,
  onPick,
  onContinue,
}: {
  edition: LicenseEdition | null;
  invalid: boolean;
  restaurantPrice: string;
  storePrice: string;
  onPick: (edition: LicenseEdition) => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div>
        <div className="text-[18px] font-semibold tracking-tight sm:text-lg">
          {t('license.businessTitle')}
        </div>
        <div className="mt-1 text-sm text-gray-400">
          {t('license.businessBody')}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
        <EditionCard
          selected={edition === 'RESTAURANT'}
          invalid={invalid}
          title={t('license.businessRestaurant')}
          price={restaurantPrice}
          hint={t('license.businessRestaurantHint')}
          onClick={() => onPick('RESTAURANT')}
        />
        <EditionCard
          selected={edition === 'STORE'}
          invalid={invalid}
          title={t('license.businessStore')}
          price={storePrice}
          hint={t('license.businessStoreHint')}
          onClick={() => onPick('STORE')}
        />
      </div>
      <Button variant="primary" block size="lg" onClick={onContinue}>
        {t('license.continue')}
      </Button>
    </>
  );
}

function EditionCard({
  selected,
  invalid,
  title,
  price,
  hint,
  onClick,
}: {
  selected: boolean;
  invalid: boolean;
  title: string;
  price?: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-h-[4.5rem] w-full rounded-lg border px-4 py-3 text-left transition-colors',
        selected
          ? 'border-[var(--pos-accent)] bg-[color-mix(in_srgb,var(--pos-accent)_16%,transparent)]'
          : invalid
            ? 'border-rose-500/60 hover:border-rose-400/80'
            : 'border-white/10 hover:border-white/25',
      )}
    >
      <div className="text-[14px] font-semibold text-gray-50">{title}</div>
      {price ? (
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-gray-50">
          {price}
        </div>
      ) : null}
      <div className="mt-0.5 text-[12px] leading-snug text-gray-400">
        {hint}
      </div>
    </button>
  );
}

function ConfirmPay({
  draft,
  busy,
  priceLabel,
  onPay,
}: {
  draft: RegisterDraft;
  busy: string | null;
  priceLabel: string;
  onPay: () => void;
}) {
  const { t } = useTranslation();
  const plan =
    draft.edition === 'STORE'
      ? t('license.businessStore')
      : t('license.businessRestaurant');
  const rows: Array<[string, string]> = [
    [t('license.confirmPlan'), plan],
    ...(priceLabel
      ? [[t('license.confirmPrice'), priceLabel] as [string, string]]
      : []),
    [t('license.name'), draft.name.trim()],
    [t('license.email'), draft.email.trim()],
    [t('license.phone'), draft.phone.trim()],
    [t('license.businessName'), draft.businessName.trim()],
  ];
  return (
    <>
      <div>
        <div className="text-[18px] font-semibold tracking-tight sm:text-lg">
          {t('license.confirmTitle')}
        </div>
        <div className="mt-1 text-sm text-gray-400">
          {t('license.confirmBody')}
        </div>
      </div>
      <dl className="space-y-2.5 text-sm">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-0.5 min-[400px]:flex-row min-[400px]:justify-between min-[400px]:gap-3"
          >
            <dt className="shrink-0 text-gray-400">{label}</dt>
            <dd className="min-w-0 break-words text-gray-100 min-[400px]:text-right">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <Button
        variant="primary"
        block
        size="lg"
        loading={busy === 'pay'}
        onClick={onPay}
      >
        {busy === 'pay'
          ? t('license.openingStripe')
          : priceLabel
            ? t('license.subscribeFor', { price: priceLabel })
            : t('license.subscribe')}
      </Button>
    </>
  );
}

function LoginKeyForm({
  licenseKey,
  busy,
  onKey,
  onActivate,
  onForgot,
}: {
  licenseKey: string;
  busy: string | null;
  onKey: (value: string) => void;
  onActivate: () => void;
  onForgot: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div>
        <div className="text-[18px] font-semibold tracking-tight sm:text-lg">
          {t('license.loginTitle')}
        </div>
        <div className="mt-1 text-sm text-gray-400">
          {t('license.loginBody')}
        </div>
      </div>
      <GateInput
        label={t('license.pasteKey')}
        value={licenseKey}
        autoComplete="off"
        spellCheck={false}
        inputClassName="font-mono text-xs"
        onChange={(e) => onKey(e.target.value)}
        placeholder="POS1...."
      />
      <Button
        variant="primary"
        block
        size="lg"
        loading={busy === 'key'}
        onClick={onActivate}
      >
        {busy === 'key' ? t('common.loading') : t('license.activateKey')}
      </Button>
      <button
        type="button"
        className="w-full text-center text-[13px] text-gray-400 underline underline-offset-2 hover:text-gray-100"
        onClick={onForgot}
      >
        {t('license.forgotKey')}
      </button>
    </>
  );
}

function ForgotKeyForm({
  email,
  busy,
  keyEmailed,
  resendIn,
  emailError,
  onEmail,
  onSend,
}: {
  email: string;
  busy: string | null;
  keyEmailed: boolean;
  resendIn: number;
  emailError?: string;
  onEmail: (value: string) => void;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  const coolingDown = resendIn > 0;
  const sending = busy === 'restore';
  const label = sending
    ? t('license.sendingKey')
    : coolingDown
      ? t('license.resendIn', { seconds: resendIn })
      : keyEmailed
        ? t('license.resendKey')
        : t('license.sendKey');
  return (
    <>
      <div>
        <div className="text-[18px] font-semibold tracking-tight sm:text-lg">
          {t('license.forgotTitle')}
        </div>
        <div className="mt-1 text-sm text-gray-400">
          {t('license.forgotBody')}
        </div>
      </div>
      <GateInput
        label={t('license.email')}
        type="email"
        autoComplete="email"
        value={email}
        error={emailError}
        onChange={(e) => onEmail(e.target.value)}
        placeholder="you@business.com"
      />
      <Button
        variant="primary"
        block
        size="lg"
        loading={sending}
        disabled={coolingDown}
        onClick={onSend}
      >
        {label}
      </Button>
    </>
  );
}

function GateInput({
  label,
  error,
  className,
  inputClassName,
  ...rest
}: {
  label: string;
  error?: string;
  className?: string;
  inputClassName?: string;
} & Omit<ComponentProps<typeof Input>, 'id' | 'invalid'>) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} error={error} className={className}>
      <Input
        id={id}
        invalid={Boolean(error)}
        className={cn(
          'w-full min-w-0 text-[16px] sm:text-[13px]',
          inputClassName,
        )}
        {...rest}
      />
    </Field>
  );
}
