/**
 * First-run setup (`@shared/setupWizard`): business, fiskalizimi (DEMO
 * only), printers with a test slip per station, menu (by hand or CSV),
 * staff, pairing devices, and a checklist. Progress is saved after every
 * step, so closing the window reopens where it was left.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { qrModulePath } from '../../components/FiscalVerifyQr';
import { toast } from '../../stores/toasts';
import {
  advanceSetup,
  businessStepErrors,
  EASYPOS_DEMO_URL,
  type FieldErrors,
  fiscalStepErrors,
  goToSetupStep,
  printerStepErrors,
  readSetupProgress,
  SETUP_STEPS,
  type SetupFacts,
  setupChecklist,
  type SetupStep,
  type SetupWizardProgress,
} from '@shared/setupWizard';
import {
  MENU_CSV_TEMPLATE,
  type MenuCsvError,
  type MenuCsvRow,
  validateMenuCsv,
} from '@shared/menuCsv';
import { staffPinError, normalizePin } from '@shared/staffPin';
import { importMenuCsvRows } from '../../utils/menuCsvImport';

type Api = any;
const api = (): Api => (window as any).api;

async function saveProgress(p: SetupWizardProgress): Promise<void> {
  await api().settings.update({ setupWizard: p });
}

function Err({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div role="alert" className="mt-1 text-[12px] text-red-300">
      {text}
    </div>
  );
}

export default function SetupWizardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<any>(null);
  const [progress, setProgress] = useState<SetupWizardProgress | null>(null);

  const reload = useCallback(async () => {
    const s = await api().settings.get();
    setSettings(s);
    setProgress((p) => p ?? readSetupProgress(s));
    return s;
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const move = useCallback(
    async (step: SetupStep, state: 'done' | 'skipped') => {
      if (!progress) return;
      const next = advanceSetup(progress, step, state);
      setProgress(next);
      try {
        await saveProgress(next);
      } catch (e: any) {
        toast.error(e?.message || t('setup.saveFailed'));
      }
      await reload();
      if (step === 'finish') navigate('/admin');
    },
    [progress, reload, navigate, t],
  );

  const jump = useCallback(
    async (step: SetupStep) => {
      if (!progress) return;
      const next = goToSetupStep(progress, step);
      setProgress(next);
      await saveProgress(next).catch(() => undefined);
    },
    [progress],
  );

  if (!settings || !progress) {
    return <div className="p-8 text-gray-400">{t('common.loading')}</div>;
  }
  const step = progress.current;
  const common = { settings, onDone: () => move(step, 'done'), reload };

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6" data-testid="setup-wizard">
      <h1 className="text-xl font-semibold">{t('setup.title')}</h1>
      <p className="mt-1 text-[13px] text-gray-400">{t('setup.intro')}</p>
      <ol className="mt-4 flex flex-wrap gap-1.5" aria-label={t('setup.steps')}>
        {SETUP_STEPS.map((s, i) => {
          const state = progress.steps[s];
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => void jump(s)}
                aria-current={s === step ? 'step' : undefined}
                className={`rounded-full border px-3 py-1 text-[12px] ${
                  s === step
                    ? 'border-sky-400 bg-sky-500/15 text-sky-100'
                    : 'border-white/10 text-gray-300'
                }`}
              >
                {state === 'done'
                  ? '✓ '
                  : state === 'skipped'
                    ? '– '
                    : `${i + 1}. `}
                {t(`setup.step.${s}`)}
              </button>
            </li>
          );
        })}
      </ol>

      <section className="mt-5 rounded-xl border border-white/10 p-4 sm:p-5">
        {step === 'business' && <BusinessStep {...common} />}
        {step === 'fiscal' && <FiscalStep {...common} />}
        {step === 'printers' && (
          <PrintersStep
            {...common}
            progress={progress}
            setProgress={setProgress}
          />
        )}
        {step === 'menu' && <MenuStep {...common} />}
        {step === 'staff' && <StaffStep {...common} />}
        {step === 'devices' && <DevicesStep {...common} />}
        {step === 'finish' && (
          <FinishStep {...common} progress={progress} onJump={jump} />
        )}
      </section>

      <div className="mt-4 flex items-center justify-between gap-2">
        <Button
          variant="secondary"
          disabled={step === SETUP_STEPS[0]}
          onClick={() =>
            void jump(SETUP_STEPS[Math.max(0, SETUP_STEPS.indexOf(step) - 1)])
          }
        >
          {t('setup.back')}
        </Button>
        <div className="flex gap-2">
          {step !== 'finish' ? (
            <Button
              variant="secondary"
              onClick={() => void move(step, 'skipped')}
            >
              {t('setup.skip')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={async () => {
                const next = { ...progress, dismissed: true };
                await saveProgress(next).catch(() => undefined);
                navigate('/admin');
              }}
            >
              {t('setup.later')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

type StepProps = {
  settings: any;
  onDone: () => Promise<void> | void;
  reload: () => Promise<any>;
};

function BusinessStep({ settings, onDone }: StepProps) {
  const { t } = useTranslation();
  const b = settings?.businessInfo || {};
  const [name, setName] = useState(
    String(settings?.restaurantName || '').replace(/^OneTap POS$/, ''),
  );
  const [address, setAddress] = useState(String(b.address || ''));
  const [country, setCountry] = useState(String(b.country || ''));
  const [currency, setCurrency] = useState(String(settings?.currency || ''));
  const [taxId, setTaxId] = useState(String(b.taxId || ''));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e = businessStepErrors({ name, address, country, currency, taxId });
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api().settings.update({
        restaurantName: name.trim(),
        currency: currency.toUpperCase(),
        businessInfo: {
          ...b,
          address: address.trim(),
          country,
          taxId: taxId.trim().toUpperCase(),
        },
      });
      await onDone();
    } catch (err: any) {
      setErrors({ form: err?.message || t('setup.saveFailed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <h2 className="text-[15px] font-semibold">{t('setup.step.business')}</h2>
      <Field label={t('setup.business.name')}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!errors.name || undefined}
        />
        <Err text={errors.name} />
      </Field>
      <Field label={t('setup.business.address')}>
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          aria-invalid={!!errors.address || undefined}
        />
        <Err text={errors.address} />
      </Field>
      <Field label={t('setup.business.country')}>
        <Select
          value={country}
          onChange={(e) => {
            setCountry(e.target.value);
            if (e.target.value === 'UK') setCurrency('GBP');
            else if (e.target.value === 'AL' && currency === 'GBP')
              setCurrency('ALL');
          }}
        >
          <option value="">—</option>
          <option value="AL">{t('setup.business.albania')}</option>
          <option value="UK">{t('setup.business.uk')}</option>
        </Select>
        <Err text={errors.country} />
      </Field>
      <Field label={t('setup.business.currency')}>
        <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          <option value="">—</option>
          {(country === 'UK' ? ['GBP'] : ['ALL', 'EUR']).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Err text={errors.currency} />
      </Field>
      <Field
        label={
          country === 'UK' ? t('setup.business.vat') : t('setup.business.nipt')
        }
      >
        <Input
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
          aria-invalid={!!errors.taxId || undefined}
        />
        <Err text={errors.taxId} />
      </Field>
      <Err text={errors.form} />
      <Button disabled={busy} onClick={() => void submit()}>
        {t('setup.saveContinue')}
      </Button>
    </div>
  );
}

function FiscalStep({ settings, onDone }: StepProps) {
  const { t } = useTranslation();
  const country = settings?.businessInfo?.country;
  const f = settings?.fiscal || {};
  const [token, setToken] = useState('');
  const [operatorCode, setOperatorCode] = useState(
    String(f.defaultOperatorId || f.operatorCode || ''),
  );
  const [integrationApp, setIntegrationApp] = useState(
    String(f.integrationApp || ''),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<null | {
    ok: boolean;
    message?: string;
  }>(null);
  if (country !== 'AL') {
    return (
      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold">{t('setup.step.fiscal')}</h2>
        <p className="text-[13px] text-gray-300">
          {t('setup.fiscal.notNeeded')}
        </p>
        <Button onClick={() => void onDone()}>{t('setup.continue')}</Button>
      </div>
    );
  }
  const saveAndTest = async () => {
    const e = fiscalStepErrors({
      baseUrl: EASYPOS_DEMO_URL,
      authToken: token,
      tokenSaved: Boolean(f.authTokenConfigured),
      operatorCode,
      integrationApp,
    });
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api().settings.update({
        fiscal: {
          provider: 'easypos',
          baseUrl: EASYPOS_DEMO_URL,
          ...(token.trim()
            ? { authToken: token.trim(), tokenEnvironment: 'dev' }
            : {}),
          defaultOperatorId: operatorCode.trim(),
          integrationApp: integrationApp.trim(),
        },
      });
      const r = await api().settings.testFiscalConnection();
      setTested({ ok: Boolean(r?.ok), message: r?.message });
      if (r?.ok) {
        await api().settings.update({
          setupFiscalTestedAt: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      setTested({ ok: false, message: err?.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <h2 className="text-[15px] font-semibold">{t('setup.step.fiscal')}</h2>
      <p className="text-[13px] text-gray-300">{t('setup.fiscal.demoOnly')}</p>
      <Field label={t('setup.fiscal.address')}>
        <Input value={EASYPOS_DEMO_URL} readOnly />
      </Field>
      <Field
        label={t('setup.fiscal.token')}
        hint={f.authTokenConfigured ? t('setup.fiscal.tokenSaved') : undefined}
      >
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Err text={errors.authToken} />
      </Field>
      <Field label={t('setup.fiscal.operator')}>
        <Input
          value={operatorCode}
          onChange={(e) => setOperatorCode(e.target.value)}
        />
        <Err text={errors.operatorCode} />
      </Field>
      <Field label={t('setup.fiscal.app')}>
        <Input
          value={integrationApp}
          onChange={(e) => setIntegrationApp(e.target.value)}
        />
        <Err text={errors.integrationApp} />
      </Field>
      <Err text={errors.baseUrl} />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void saveAndTest()}>
          {busy ? t('setup.fiscal.testing') : t('setup.fiscal.test')}
        </Button>
        {tested?.ok ? (
          <Button onClick={() => void onDone()}>{t('setup.continue')}</Button>
        ) : null}
      </div>
      {tested ? (
        <div
          role="status"
          className={`text-[13px] ${tested.ok ? 'text-emerald-300' : 'text-red-300'}`}
        >
          {tested.ok
            ? t('setup.fiscal.ok')
            : `${t('setup.fiscal.failed')} ${tested.message || ''}`}
        </div>
      ) : null}
    </div>
  );
}

const STATIONS = ['RECEIPT', 'KITCHEN', 'BAR', 'DESSERT'] as const;
type StationKey = (typeof STATIONS)[number];

function PrintersStep({
  settings,
  onDone,
  reload,
  progress,
  setProgress,
}: StepProps & {
  progress: SetupWizardProgress;
  setProgress: (p: SetupWizardProgress) => void;
}) {
  const { t } = useTranslation();
  const printers: any[] = Array.isArray(settings?.printers)
    ? settings.printers
    : [];
  const routing = settings?.printerRouting || {};
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('9100');
  const [roles, setRoles] = useState<StationKey[]>(['KITCHEN']);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [found, setFound] = useState<Array<{ ip: string; port?: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const printed: string[] = ((progress as any).testPrinted as string[]) || [];

  const assigned = (s: StationKey): any =>
    printers.find((p) =>
      s === 'RECEIPT'
        ? p.id === routing.receiptPrinterId
        : p.id === routing.station?.[s],
    );

  const scan = async () => {
    setBusy('scan');
    try {
      const rows = await api().settings.scanNetworkPrinters();
      setFound(Array.isArray(rows) ? rows : []);
      if (!rows?.length) toast.info(t('setup.printers.noneFound'));
    } catch (e: any) {
      toast.error(e?.message || t('setup.printers.scanFailed'));
    } finally {
      setBusy(null);
    }
  };
  const add = async () => {
    const e = printerStepErrors({ name, ip, port });
    if (!roles.length) e.roles = t('setup.printers.chooseRole');
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy('add');
    try {
      const id = `p-${Date.now().toString(36)}`;
      const profile = {
        id,
        name: name.trim(),
        enabled: true,
        mode: 'NETWORK',
        ip: ip.trim(),
        port: Number(port),
      };
      const station = { ...(routing.station || {}) };
      for (const r of roles) if (r !== 'RECEIPT') station[r] = id;
      await api().settings.update({
        printers: [...printers, profile],
        printerRouting: {
          ...routing,
          enabled: true,
          station,
          ...(roles.includes('RECEIPT') ? { receiptPrinterId: id } : {}),
          ...(routing.fallbackPrinterId ? {} : { fallbackPrinterId: id }),
        },
      });
      setName('');
      setIp('');
      await reload();
    } catch (err: any) {
      setErrors({ form: err?.message || t('setup.saveFailed') });
    } finally {
      setBusy(null);
    }
  };
  const test = async (s: StationKey) => {
    const p = assigned(s);
    if (!p) return;
    setBusy(`test:${s}`);
    try {
      const r = await api().settings.testPrintProfile(p);
      if (r?.ok) {
        const next = {
          ...progress,
          testPrinted: Array.from(new Set([...printed, s])),
        } as any;
        setProgress(next);
        await saveProgress(next).catch(() => undefined);
        toast.success(
          t('setup.printers.printed', { station: t(`setup.station.${s}`) }),
        );
      } else toast.error(r?.error || t('setup.printers.testFailed'));
    } catch (e: any) {
      toast.error(e?.message || t('setup.printers.testFailed'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3">
      <h2 className="text-[15px] font-semibold">{t('setup.step.printers')}</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {STATIONS.map((s) => {
          const p = assigned(s);
          return (
            <div
              key={s}
              className="flex items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-[13px]"
            >
              <div>
                <div className="font-medium">
                  {printed.includes(s) ? '✓ ' : ''}
                  {t(`setup.station.${s}`)}
                </div>
                <div className="text-gray-400">
                  {p
                    ? `${p.name} · ${p.ip}:${p.port}`
                    : t('setup.printers.none')}
                </div>
              </div>
              {p ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy != null}
                  onClick={() => void test(s)}
                >
                  {busy === `test:${s}` ? '…' : t('setup.printers.test')}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      <h3 className="pt-2 text-[13px] font-semibold">
        {t('setup.printers.add')}
      </h3>
      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="secondary"
          disabled={busy != null}
          onClick={() => void scan()}
        >
          {busy === 'scan'
            ? t('setup.printers.scanning')
            : t('setup.printers.scan')}
        </Button>
        {found.map((f) => (
          <Button
            key={`${f.ip}:${f.port}`}
            size="sm"
            variant="secondary"
            onClick={() => {
              setIp(f.ip);
              setPort(String(f.port || 9100));
            }}
          >
            {f.ip}:{f.port || 9100}
          </Button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label={t('setup.printers.name')}>
          <Input
            value={name}
            placeholder="Kitchen"
            onChange={(e) => setName(e.target.value)}
          />
          <Err text={errors.name} />
        </Field>
        <Field label={t('setup.printers.ip')}>
          <Input
            value={ip}
            placeholder="192.168.1.50"
            onChange={(e) => setIp(e.target.value)}
          />
          <Err text={errors.ip} />
        </Field>
        <Field label={t('setup.printers.port')}>
          <Input
            value={port}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value)}
          />
          <Err text={errors.port} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-3 text-[13px]">
        {STATIONS.map((s) => (
          <label key={s} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={roles.includes(s)}
              onChange={(e) =>
                setRoles((r) =>
                  e.target.checked ? [...r, s] : r.filter((x) => x !== s),
                )
              }
            />
            {t(`setup.station.${s}`)}
          </label>
        ))}
      </div>
      <Err text={errors.roles || errors.form} />
      <div className="flex gap-2">
        <Button
          variant="secondary"
          disabled={busy != null}
          onClick={() => void add()}
        >
          {t('setup.printers.addButton')}
        </Button>
        <Button disabled={!printers.length} onClick={() => void onDone()}>
          {t('setup.continue')}
        </Button>
      </div>
    </div>
  );
}

function MenuStep({ onDone }: StepProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MenuCsvRow[]>([]);
  const [errors, setErrors] = useState<MenuCsvError[]>([]);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [cat, setCat] = useState('');
  const [item, setItem] = useState('');
  const [price, setPrice] = useState('');
  const [station, setStation] = useState('KITCHEN');
  const [manualErr, setManualErr] = useState<MenuCsvError[]>([]);

  const refreshCount = useCallback(async () => {
    const menu = await api()
      .menu.listCategoriesWithItems()
      .catch(() => []);
    setCount(
      (menu || []).reduce((a: number, c: any) => a + (c.items?.length || 0), 0),
    );
  }, []);
  useEffect(() => {
    void refreshCount();
  }, [refreshCount]);

  const template = () => {
    const blob = new Blob([MENU_CSV_TEMPLATE], {
      type: 'text/csv;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'menu-template.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const runImport = async (list: MenuCsvRow[]) => {
    setBusy(true);
    try {
      const r = await importMenuCsvRows(list, api().menu);
      setResult(
        t('setup.menu.imported', {
          created: r.created,
          existing: r.existing,
          categories: r.categories,
        }) +
          (r.failed.length
            ? ` ${t('setup.menu.someFailed', { count: r.failed.length })}`
            : ''),
      );
      setErrors(r.failed.map((f) => ({ line: f.line, message: f.message })));
      await refreshCount();
      return r;
    } finally {
      setBusy(false);
    }
  };
  const addOne = async () => {
    const line = `category,name,price,vat_rate,station\n"${cat.replace(/"/g, '""')}","${item.replace(/"/g, '""')}",${price},,${station}`;
    const v = validateMenuCsv(line);
    setManualErr(v.errors);
    if (v.errors.length) return;
    const r = await runImport(v.rows);
    if (!r.failed.length) {
      setItem('');
      setPrice('');
    }
  };
  return (
    <div className="space-y-3">
      <h2 className="text-[15px] font-semibold">{t('setup.step.menu')}</h2>
      {count != null ? (
        <div className="text-[13px] text-gray-400">
          {t('setup.menu.count', { count })}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={template}>
          {t('setup.menu.template')}
        </Button>
        <label className="pos-btn cursor-pointer">
          {t('setup.menu.chooseCsv')}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setFileName(file.name);
              setResult(null);
              const v = validateMenuCsv(await file.text());
              setRows(v.rows);
              setErrors(v.errors);
            }}
          />
        </label>
      </div>
      {fileName ? (
        <div className="text-[13px]">
          {fileName}:{' '}
          {errors.length
            ? t('setup.menu.errors', { count: errors.length })
            : t('setup.menu.ready', { count: rows.length })}
        </div>
      ) : null}
      {errors.length ? (
        <div
          role="alert"
          className="max-h-56 overflow-auto rounded-lg border border-red-400/30"
        >
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-gray-400">
                <th className="px-2 py-1">{t('setup.menu.line')}</th>
                <th className="px-2 py-1">{t('setup.menu.column')}</th>
                <th className="px-2 py-1">{t('setup.menu.problem')}</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((er, i) => (
                <tr key={i} className="border-t border-white/5">
                  <td className="px-2 py-1 tabular-nums">{er.line}</td>
                  <td className="px-2 py-1">{er.column || ''}</td>
                  <td className="px-2 py-1 text-red-200">{er.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {rows.length && !errors.length ? (
        <Button disabled={busy} onClick={() => void runImport(rows)}>
          {busy
            ? t('setup.menu.importing')
            : t('setup.menu.import', { count: rows.length })}
        </Button>
      ) : null}
      {result ? (
        <div role="status" className="text-[13px] text-emerald-300">
          {result}
        </div>
      ) : null}

      <h3 className="pt-2 text-[13px] font-semibold">
        {t('setup.menu.manual')}
      </h3>
      <div className="grid gap-2 sm:grid-cols-4">
        <Input
          placeholder={t('setup.menu.category')}
          value={cat}
          onChange={(e) => setCat(e.target.value)}
        />
        <Input
          placeholder={t('setup.menu.item')}
          value={item}
          onChange={(e) => setItem(e.target.value)}
        />
        <Input
          placeholder="0.00"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <Select value={station} onChange={(e) => setStation(e.target.value)}>
          {['KITCHEN', 'BAR', 'DESSERT'].map((s) => (
            <option key={s} value={s}>
              {t(`setup.station.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      {manualErr.map((er, i) => (
        <Err key={i} text={er.message} />
      ))}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void addOne()}
        >
          {t('setup.menu.add')}
        </Button>
        <Button disabled={!count} onClick={() => void onDone()}>
          {t('setup.continue')}
        </Button>
      </div>
    </div>
  );
}

function StaffStep({ onDone }: StepProps) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState('WAITER');
  const [errors, setErrors] = useState<FieldErrors>({});
  const load = useCallback(async () => {
    setUsers(
      await api()
        .auth.listUsers({ includeAdmins: true })
        .catch(() => []),
    );
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const add = async () => {
    const e: FieldErrors = {};
    if (name.trim().length < 2) e.name = t('setup.staff.nameRequired');
    const pinErr = staffPinError(pin, role as any);
    if (pinErr) e.pin = t(`setup.staff.pin.${pinErr}`);
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      await api().auth.createUser({
        displayName: name.trim(),
        pin: normalizePin(pin),
        role,
        active: true,
      });
      setName('');
      setPin('');
      await load();
    } catch (err: any) {
      setErrors({ form: err?.message || t('setup.saveFailed') });
    }
  };
  return (
    <div className="space-y-3">
      <h2 className="text-[15px] font-semibold">{t('setup.step.staff')}</h2>
      <ul className="space-y-1 text-[13px]">
        {users.map((u) => (
          <li key={u.id}>
            {u.displayName} ·{' '}
            {t(`setup.role.${u.role}`, { defaultValue: u.role })}
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label={t('setup.staff.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <Err text={errors.name} />
        </Field>
        <Field label={t('setup.staff.pinLabel')}>
          <Input
            value={pin}
            inputMode="numeric"
            type="password"
            onChange={(e) => setPin(e.target.value)}
          />
          <Err text={errors.pin} />
        </Field>
        <Field label={t('setup.staff.role')}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {['WAITER', 'CASHIER', 'BARTENDER', 'CHEF', 'ADMIN'].map((r) => (
              <option key={r} value={r}>
                {t(`setup.role.${r}`, { defaultValue: r })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Err text={errors.form} />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => void add()}>
          {t('setup.staff.add')}
        </Button>
        <Button onClick={() => void onDone()}>{t('setup.continue')}</Button>
      </div>
    </div>
  );
}

function QrBox({ value }: { value: string }) {
  const path = useMemo(() => qrModulePath(value), [value]);
  return (
    <svg
      viewBox={`0 0 ${path.size} ${path.size}`}
      width={160}
      height={160}
      shapeRendering="crispEdges"
      role="img"
      aria-label={value}
      className="rounded bg-white p-1"
    >
      <rect width={path.size} height={path.size} fill="#fff" />
      <path fill="#000" d={path.d} />
    </svg>
  );
}

function DevicesStep({ settings, onDone, reload }: StepProps) {
  const { t } = useTranslation();
  const [ips, setIps] = useState<string[]>([]);
  const code = String(settings?.security?.pairingCode || '');
  useEffect(() => {
    void api()
      .network?.getIps?.()
      .then((r: any) =>
        setIps(
          (Array.isArray(r) ? r : [])
            .map((x: any) => String(x?.address || x))
            .filter(Boolean),
        ),
      )
      .catch(() => setIps([]));
  }, []);
  const host = ips[0] || '';
  const makeCode = async () => {
    const next = String(Math.floor(100000 + Math.random() * 900000));
    await api().settings.update({ security: { pairingCode: next } });
    await reload();
  };
  return (
    <div className="space-y-3">
      <h2 className="text-[15px] font-semibold">{t('setup.step.devices')}</h2>
      <p className="text-[13px] text-gray-300">{t('setup.devices.help')}</p>
      <div className="flex flex-wrap items-start gap-4">
        {host ? <QrBox value={`http://${host}:3333/`} /> : null}
        <div className="space-y-1 text-[14px]">
          <div>
            {t('setup.devices.address')}:{' '}
            <b className="tabular-nums">
              {host ? `${host}:3333` : t('setup.devices.noAddress')}
            </b>
          </div>
          <div>
            {t('setup.devices.code')}:{' '}
            <b className="tabular-nums tracking-widest">{code || '—'}</b>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void makeCode()}>
            {code ? t('setup.devices.newCode') : t('setup.devices.makeCode')}
          </Button>
          <ul className="list-disc pl-5 text-[13px] text-gray-300">
            <li>{t('setup.devices.waiterApp')}</li>
            <li>{t('setup.devices.kds')}</li>
          </ul>
        </div>
      </div>
      <Button onClick={() => void onDone()}>{t('setup.continue')}</Button>
    </div>
  );
}

function FinishStep({
  settings,
  onDone,
  progress,
  onJump,
}: StepProps & {
  progress: SetupWizardProgress;
  onJump: (s: SetupStep) => void;
}) {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<SetupFacts | null>(null);
  useEffect(() => {
    void (async () => {
      const [menu, users] = await Promise.all([
        api()
          .menu.listCategoriesWithItems()
          .catch(() => []),
        api()
          .auth.listUsers({ includeAdmins: true })
          .catch(() => []),
      ]);
      setFacts({
        businessName: String(settings?.restaurantName || ''),
        address: String(settings?.businessInfo?.address || ''),
        country: (settings?.businessInfo?.country || '') as any,
        fiscalEnabled: Boolean(
          settings?.fiscal?.authTokenConfigured && settings?.fiscal?.baseUrl,
        ),
        fiscalTested: Boolean(settings?.setupFiscalTestedAt),
        printers: Array.isArray(settings?.printers)
          ? settings.printers.length
          : 0,
        testPrinted: (((progress as any).testPrinted as string[]) || []).length,
        menuItems: (menu || []).reduce(
          (a: number, c: any) => a + (c.items?.length || 0),
          0,
        ),
        staff: (users || []).length,
        admins: (users || []).filter((u: any) => u.role === 'ADMIN').length,
        pairingCode: Boolean(settings?.security?.pairingCode),
      });
    })();
  }, [settings, progress]);
  const list = facts ? setupChecklist(facts) : [];
  return (
    <div className="space-y-3">
      <h2 className="text-[15px] font-semibold">{t('setup.step.finish')}</h2>
      <ul className="space-y-1.5" data-testid="setup-checklist">
        {list.map((l) => (
          <li
            key={l.key}
            className="flex items-center justify-between gap-2 text-[13px]"
          >
            <span>
              <span
                aria-hidden
                className={l.ok ? 'text-emerald-300' : 'text-amber-300'}
              >
                {l.ok ? '✓' : '!'}
              </span>{' '}
              <b>{t(`setup.step.${l.key}`)}</b> · {l.detail}
              <span className="sr-only">
                {l.ok ? t('setup.ok') : t('setup.missing')}
              </span>
            </span>
            {!l.ok ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onJump(l.key)}
              >
                {t('setup.fix')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-gray-300">{t('setup.finish.next')}</p>
      <Button onClick={() => void onDone()}>{t('setup.finish.done')}</Button>
    </div>
  );
}
