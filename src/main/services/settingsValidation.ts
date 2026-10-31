/**
 * Settings the till refuses to save (QA round 6, #4).
 *
 * The settings routes merged whatever they were sent: an exchange rate of
 * "abc" or −1 (every euro invoice then failed, or was filed at a negative
 * value), a currency "XXX" no screen or invoice can show, and the easyPos
 * production address while the token was the DEMO one (every invoice then
 * refused by the live service, or worse, the other way round). These are
 * checked here, when saved, with a message the owner can act on.
 */
import { fiscalEnvironmentOf, type FiscalEnvironment } from './fiscal/config';

/** The currencies the till can sell in (the Admin currency list). */
export const SUPPORTED_CURRENCIES = [
  'ALL',
  'EUR',
  'USD',
  'GBP',
  'QAR',
  'AED',
] as const;

/** Lekë per unit of the venue currency. EUR is ~100; anything else is a typo. */
export const EXCHANGE_RATE_MIN = 0.01;
export const EXCHANGE_RATE_MAX = 1000;

export const INVALID_SETTINGS = 'INVALID_SETTINGS';
export const FISCAL_ADDRESS_REQUIRED = 'FISCAL_ADDRESS_REQUIRED';
export const FISCAL_TOKEN_ENVIRONMENT_MISMATCH =
  'FISCAL_TOKEN_ENVIRONMENT_MISMATCH';

function refuse(message: string, code = INVALID_SETTINGS): never {
  throw Object.assign(new Error(message), { code, statusCode: 400 });
}

const has = (o: unknown, k: string) =>
  Boolean(o) &&
  typeof o === 'object' &&
  Object.prototype.hasOwnProperty.call(o, k);

/** Why `rate` is not a usable exchange rate, or null (unset is fine). */
export function exchangeRateProblem(rate: unknown): string | null {
  if (rate === null || rate === undefined || rate === '') return null;
  const n = typeof rate === 'number' ? rate : Number(rate);
  if (typeof rate === 'boolean' || !Number.isFinite(n)) {
    return 'The exchange rate must be a number.';
  }
  if (n < EXCHANGE_RATE_MIN || n > EXCHANGE_RATE_MAX) {
    return `The exchange rate must be between ${EXCHANGE_RATE_MIN} and ${EXCHANGE_RATE_MAX} lekë.`;
  }
  return null;
}

export function currencyProblem(currency: unknown): string | null {
  const code = String(currency ?? '')
    .trim()
    .toUpperCase();
  if ((SUPPORTED_CURRENCIES as readonly string[]).includes(code)) return null;
  return `"${String(currency ?? '')}" is not a supported currency (${SUPPORTED_CURRENCIES.join(', ')}).`;
}

/**
 * The easyPos environment a token says it is for, when it says so: the
 * claims of a JWT (`env`, `environment`, issuer or audience naming the
 * demo or test service). Null when the token does not tell.
 */
export function tokenClaimedEnvironment(
  token: unknown,
): Exclude<FiscalEnvironment, 'local'> | null {
  const raw = String(token || '')
    .trim()
    .replace(/^bearer\s+/i, '');
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const said = ['env', 'environment', 'iss', 'aud']
    .map((k) => claims?.[k])
    .flat()
    .map((v) => String(v ?? '').toLowerCase())
    .join(' ');
  if (!said.trim()) return null;
  if (/\b(dev|demo|test|sandbox|staging)\b|api\.dev\.easypos/.test(said)) {
    return 'dev';
  }
  if (/\b(prod|production|live)\b|api\.easypos\.al/.test(said)) return 'prod';
  return null;
}

/**
 * Refuse a settings change the till must not save. `current` is what is
 * saved now; `input` the patch. Returns the environment the fiscal token
 * is for after this save (stored as `fiscal.tokenEnvironment`), or
 * undefined when the patch does not touch the fiscal service.
 */
export function assertSettingsPatch(
  input: Record<string, any> | null | undefined,
  current: Record<string, any> | null | undefined,
): FiscalEnvironment | undefined {
  if (!input || typeof input !== 'object') return undefined;

  // Only a change: every preferences save re-sends the saved currency, and
  // one saved before this check must not block the rest of the screen.
  const norm = (c: unknown) =>
    String(c ?? '')
      .trim()
      .toUpperCase();
  if (
    has(input, 'currency') &&
    norm(input.currency) !== norm(current?.currency)
  ) {
    const problem = currencyProblem(input.currency);
    if (problem) refuse(problem);
  }

  const rates: unknown[] = [];
  if (has(input.fiscal, 'eurExchangeRate')) {
    rates.push(input.fiscal.eurExchangeRate);
  }
  if (has(input.preferences, 'eurExchangeRate')) {
    rates.push(input.preferences.eurExchangeRate);
  }
  const perCurrency = input.fiscal?.exchangeRates;
  if (perCurrency && typeof perCurrency === 'object') {
    for (const [code, rate] of Object.entries(perCurrency)) {
      const problem = currencyProblem(code);
      if (problem) refuse(problem);
      rates.push(rate);
    }
  }
  for (const rate of rates) {
    const problem = exchangeRateProblem(rate);
    if (problem) refuse(problem);
  }

  // A fiscal receipt states the seller's address; the receipt header prints
  // it from Settings → About (`print.ts`). Turning fiscalization on without
  // one printed receipts with no seller address (QA round 6, fiscal).
  const switchingOn =
    input.fiscal?.enabled === true && current?.fiscal?.enabled !== true;
  if (switchingOn) {
    const address = has(input.businessInfo, 'address')
      ? input.businessInfo.address
      : current?.businessInfo?.address;
    if (!String(address ?? '').trim()) {
      refuse(
        "Enter the business address (Settings → About) before turning on fiscalization: fiscal receipts must show the seller's address.",
        FISCAL_ADDRESS_REQUIRED,
      );
    }
  }

  if (!input.fiscal || typeof input.fiscal !== 'object') return undefined;
  const fiscalNow = current?.fiscal || {};
  const baseUrl = has(input.fiscal, 'baseUrl')
    ? String(input.fiscal.baseUrl || '')
    : String(fiscalNow.baseUrl || '');
  const newToken = String(input.fiscal.authToken || '').trim();
  const urlEnv = fiscalEnvironmentOf(baseUrl);
  if (!baseUrl.trim() || urlEnv === 'local') {
    return newToken ? 'local' : fiscalNow.tokenEnvironment;
  }
  // The environment the token is for: what it says, else what it was
  // entered for (saved with it), when it is the token already saved.
  // A token kept while the address moves between DEMO and production was
  // in use with the previous address: it is that one's.
  const prevEnv = fiscalEnvironmentOf(String(fiscalNow.baseUrl || ''));
  const keptFromPrevious =
    !newToken &&
    String(fiscalNow.authToken || '').trim() &&
    String(fiscalNow.baseUrl || '').trim() &&
    prevEnv !== 'local'
      ? prevEnv
      : null;
  const tokenEnv =
    tokenClaimedEnvironment(newToken || fiscalNow.authToken) ??
    (newToken
      ? null
      : (fiscalNow.tokenEnvironment ?? keptFromPrevious ?? null));
  if (tokenEnv && tokenEnv !== 'local' && tokenEnv !== urlEnv) {
    const label = (e: string) => (e === 'dev' ? 'DEMO (test)' : 'production');
    refuse(
      `The fiscal token is for the easyPos ${label(tokenEnv)} service, but the address is the ${label(urlEnv)} one. Enter the ${label(urlEnv)} token with the ${label(urlEnv)} address.`,
      FISCAL_TOKEN_ENVIRONMENT_MISMATCH,
    );
  }
  // A new token is taken to be for the address it is saved with.
  return newToken ? urlEnv : (tokenEnv ?? fiscalNow.tokenEnvironment);
}
