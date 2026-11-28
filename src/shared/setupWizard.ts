/**
 * The first-run setup wizard: its steps, and its progress, saved in the
 * settings (`settings.setupWizard`) after every step so closing the window
 * mid-way reopens at the same step.
 *
 * Every step can be skipped and come back to; "Finish" shows what is done
 * and what is still missing. The wizard opens by itself on a till with no
 * business set up and can be reopened from Admin › Settings.
 */

export const SETUP_STEPS = [
  'business',
  'fiscal',
  'printers',
  'menu',
  'staff',
  'devices',
  'finish',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export type StepState = 'done' | 'skipped';

export interface SetupWizardProgress {
  /** The step to open at. */
  current: SetupStep;
  steps: Partial<Record<SetupStep, StepState>>;
  startedAt?: string;
  finishedAt?: string;
  /** "Don't open by itself again" without finishing. */
  dismissed?: boolean;
}

export function isSetupStep(v: unknown): v is SetupStep {
  return (SETUP_STEPS as readonly string[]).includes(String(v));
}

/** Progress read from settings, with defaults (never throws). */
export function readSetupProgress(settings: any): SetupWizardProgress {
  const raw = settings?.setupWizard;
  const steps: SetupWizardProgress['steps'] = {};
  if (raw?.steps && typeof raw.steps === 'object') {
    for (const [k, v] of Object.entries(raw.steps)) {
      if (isSetupStep(k) && (v === 'done' || v === 'skipped')) steps[k] = v;
    }
  }
  return {
    current: isSetupStep(raw?.current) ? raw.current : 'business',
    steps,
    ...(raw?.startedAt ? { startedAt: String(raw.startedAt) } : {}),
    ...(raw?.finishedAt ? { finishedAt: String(raw.finishedAt) } : {}),
    ...(raw?.dismissed === true ? { dismissed: true } : {}),
  };
}

/** The progress after leaving `step` as done or skipped: on to the next. */
export function advanceSetup(
  progress: SetupWizardProgress,
  step: SetupStep,
  state: StepState,
  now = new Date(),
): SetupWizardProgress {
  const i = SETUP_STEPS.indexOf(step);
  const next = SETUP_STEPS[Math.min(SETUP_STEPS.length - 1, i + 1)];
  return {
    ...progress,
    steps: { ...progress.steps, [step]: state },
    current: next,
    startedAt: progress.startedAt || now.toISOString(),
    ...(step === 'finish' ? { finishedAt: now.toISOString() } : {}),
  };
}

/** Going back (or jumping) to a step keeps what was done. */
export function goToSetupStep(
  progress: SetupWizardProgress,
  step: SetupStep,
): SetupWizardProgress {
  return { ...progress, current: step };
}

/**
 * Whether the wizard opens by itself: no business name yet (a fresh
 * install), and it was neither finished nor dismissed.
 */
export function setupWizardShouldOpen(settings: any): boolean {
  const p = readSetupProgress(settings);
  if (p.finishedAt || p.dismissed) return false;
  const name = String(settings?.restaurantName || '').trim();
  const configured = name && name !== 'OneTap POS' && name !== 'My Restaurant';
  return !configured || Object.keys(p.steps).length > 0;
}

export interface SetupFacts {
  businessName: string;
  address: string;
  country: 'AL' | 'UK' | '';
  fiscalEnabled: boolean;
  fiscalTested: boolean;
  printers: number;
  testPrinted: number;
  menuItems: number;
  staff: number;
  admins: number;
  pairingCode: boolean;
}

/** The finish checklist: each line done or not, with what is missing. */
export function setupChecklist(
  f: SetupFacts,
): Array<{ key: SetupStep; ok: boolean; detail: string }> {
  return [
    {
      key: 'business',
      ok: Boolean(f.businessName && f.address && f.country),
      detail: !f.businessName
        ? 'Business name missing'
        : !f.address
          ? 'Address missing'
          : !f.country
            ? 'Country not chosen'
            : f.businessName,
    },
    {
      key: 'fiscal',
      ok: f.country !== 'AL' || (f.fiscalEnabled && f.fiscalTested),
      detail:
        f.country !== 'AL'
          ? 'Not needed'
          : !f.fiscalEnabled
            ? 'Fiskalizimi is not set up: sales cannot be filed'
            : f.fiscalTested
              ? 'Connected'
              : 'Not tested yet',
    },
    {
      key: 'printers',
      ok: f.printers > 0 && f.testPrinted > 0,
      detail:
        f.printers === 0
          ? 'No printer added'
          : `${f.printers} printer(s), ${f.testPrinted} test slip(s) printed`,
    },
    {
      key: 'menu',
      ok: f.menuItems > 0,
      detail: f.menuItems ? `${f.menuItems} item(s)` : 'No menu items yet',
    },
    {
      key: 'staff',
      ok: f.admins > 0 && f.staff > f.admins,
      detail:
        f.admins === 0
          ? 'No admin'
          : f.staff > f.admins
            ? `${f.staff} staff`
            : 'No waiters yet',
    },
    {
      key: 'devices',
      ok: f.pairingCode,
      detail: f.pairingCode
        ? 'Pairing code set'
        : 'No pairing code: any device on the Wi-Fi can connect',
    },
  ];
}

/** easyPos DEMO (test) address: the only one the wizard will save. */
export const EASYPOS_DEMO_URL =
  'https://api.dev.easypos.al/fiscalisation-service/v1';

export type FieldErrors = Record<string, string>;

/** Business step: name, address, country and currency, tax number shape. */
export function businessStepErrors(input: {
  name: string;
  address: string;
  country: string;
  currency: string;
  taxId: string;
}): FieldErrors {
  const e: FieldErrors = {};
  const name = input.name.trim();
  if (name.length < 2) e.name = 'Enter the business name (at least 2 letters).';
  else if (name.length > 80) e.name = 'Keep the name under 80 characters.';
  if (input.address.trim().length < 5) {
    e.address = 'Enter the full address: it is printed on every receipt.';
  }
  if (input.country !== 'AL' && input.country !== 'UK') {
    e.country = 'Choose Albania or the United Kingdom.';
  }
  const cur = input.currency.toUpperCase();
  const allowed = input.country === 'UK' ? ['GBP'] : ['ALL', 'EUR'];
  if (input.country && !allowed.includes(cur)) {
    e.currency =
      input.country === 'UK'
        ? 'A UK venue sells in GBP.'
        : 'An Albanian venue sells in ALL or EUR.';
  }
  const tax = input.taxId.trim().toUpperCase().replace(/\s+/g, '');
  if (tax) {
    // NIPT: a letter, 8 digits, a letter (L12345678A). UK VAT: GB + 9 digits.
    if (input.country === 'AL' && !/^[A-Z]\d{8}[A-Z]$/.test(tax)) {
      e.taxId = 'A NIPT is a letter, 8 digits and a letter, e.g. L12345678A.';
    }
    if (input.country === 'UK' && !/^(GB)?\d{9}(\d{3})?$/.test(tax)) {
      e.taxId = 'A UK VAT number is 9 digits, e.g. GB123456789.';
    }
  } else if (input.country === 'AL') {
    e.taxId = 'Enter the NIPT: fiscal invoices need it.';
  }
  return e;
}

/** Fiscal step (Albania): DEMO only during setup; token and codes present. */
export function fiscalStepErrors(input: {
  baseUrl: string;
  authToken: string;
  tokenSaved: boolean;
  operatorCode: string;
  integrationApp: string;
}): FieldErrors {
  const e: FieldErrors = {};
  if (input.baseUrl.trim().replace(/\/+$/, '') !== EASYPOS_DEMO_URL) {
    e.baseUrl =
      'Setup only connects to the easyPos DEMO (test) service. Switch to the live service later in Settings › Fiskalizimi, once test sales work.';
  }
  if (!input.authToken.trim() && !input.tokenSaved) {
    e.authToken = 'Paste the DEMO access token from easyPos.';
  }
  if (!/^[a-z]{2}\d{3}[a-z]{2}\d{3}$/i.test(input.operatorCode.trim())) {
    e.operatorCode =
      'The operator code is two letters, three digits, two letters, three digits (e.g. ab123cd456).';
  }
  if (!input.integrationApp.trim()) {
    e.integrationApp = 'Enter the integration app ID easyPos gave you.';
  }
  return e;
}

/** A network printer address: IPv4 or a host name, port 1-65535. */
export function printerStepErrors(input: {
  name: string;
  ip: string;
  port: string;
}): FieldErrors {
  const e: FieldErrors = {};
  if (!input.name.trim()) e.name = 'Give the printer a name, e.g. Kitchen.';
  const ip = input.ip.trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!ip) e.ip = 'Enter the printer address, e.g. 192.168.1.50.';
  else if (
    v4 ? v4.slice(1).some((n) => Number(n) > 255) : !/^[a-z0-9.-]+$/i.test(ip)
  ) {
    e.ip = `"${ip}" is not a network address.`;
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    e.port = 'The port is a number from 1 to 65535 (usually 9100).';
  }
  return e;
}
