/** QA round 6, #4: settings the till refuses to save. */
import { describe, expect, it } from 'vitest';
import { fiscalBaseUrlProblem } from './fiscal/config';
import {
  assertSettingsPatch,
  currencyProblem,
  exchangeRateProblem,
  tokenClaimedEnvironment,
} from './settingsValidation';

const DEMO = 'https://api.dev.easypos.al/fiscalisation-service/v1';
const PROD = 'https://api.easypos.al/fiscalisation-service/v1';
const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: object) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;

describe('exchange rate', () => {
  it.each(['abc', -1, 0, 0.001, 5000, true, 'NaN'])('refuses %s', (rate) => {
    expect(exchangeRateProblem(rate)).not.toBeNull();
    expect(() =>
      assertSettingsPatch({ fiscal: { eurExchangeRate: rate } }, {}),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SETTINGS' }));
  });

  it('accepts a real rate, and clearing it', () => {
    for (const rate of [97.53, '98', null, '']) {
      expect(exchangeRateProblem(rate)).toBeNull();
    }
    expect(() =>
      assertSettingsPatch({ preferences: { eurExchangeRate: 'abc' } }, {}),
    ).toThrow(/exchange rate must be a number/);
  });

  it('checks per-currency rates and their codes', () => {
    expect(() =>
      assertSettingsPatch({ fiscal: { exchangeRates: { USD: -2 } } }, {}),
    ).toThrow(/between/);
    expect(() =>
      assertSettingsPatch({ fiscal: { exchangeRates: { XXX: 90 } } }, {}),
    ).toThrow(/not a supported currency/);
  });
});

describe('currency', () => {
  it('refuses a code outside the supported list', () => {
    expect(currencyProblem('XXX')).toMatch(/not a supported currency/);
    expect(() => assertSettingsPatch({ currency: 'XXX' }, {})).toThrow(
      expect.objectContaining({ code: 'INVALID_SETTINGS', statusCode: 400 }),
    );
  });

  it('accepts the listed ones in any case', () => {
    for (const c of ['ALL', 'eur', 'USD', 'GBP', 'QAR', 'AED']) {
      expect(currencyProblem(c)).toBeNull();
    }
  });

  it('re-saving a currency saved before the check does not block other settings', () => {
    expect(() =>
      assertSettingsPatch(
        { currency: 'LEK', preferences: { theme: 'dark' } },
        { currency: 'LEK' },
      ),
    ).not.toThrow();
  });
});

describe('fiscal address and token', () => {
  it('only easyPos Cloud hosts or local middleware', () => {
    expect(fiscalBaseUrlProblem(DEMO)).toBeNull();
    expect(fiscalBaseUrlProblem(PROD)).toBeNull();
    expect(fiscalBaseUrlProblem('http://192.168.1.20:8080')).toBeNull();
    expect(fiscalBaseUrlProblem('http://localhost:5000')).toBeNull();
    expect(fiscalBaseUrlProblem('https://fiscal.example.com/v1')).toMatch(
      /not allowed/,
    );
    expect(fiscalBaseUrlProblem('http://8.8.8.8/v1')).toMatch(/not allowed/);
  });

  it('blocks switching to production with the DEMO token in use', () => {
    const saved = { fiscal: { baseUrl: DEMO, authToken: 'demo-token' } };
    expect(() =>
      assertSettingsPatch({ fiscal: { baseUrl: PROD } }, saved),
    ).toThrow(
      expect.objectContaining({
        code: 'FISCAL_TOKEN_ENVIRONMENT_MISMATCH',
        message: expect.stringMatching(/DEMO \(test\).*production/),
      }),
    );
  });

  it('allows the switch with a new token for that address, and records it', () => {
    const saved = { fiscal: { baseUrl: DEMO, authToken: 'demo-token' } };
    expect(
      assertSettingsPatch(
        { fiscal: { baseUrl: PROD, authToken: 'live-token' } },
        saved,
      ),
    ).toBe('prod');
    // The recorded environment then holds for a later save of the URL alone.
    expect(() =>
      assertSettingsPatch(
        { fiscal: { baseUrl: DEMO } },
        {
          fiscal: {
            baseUrl: PROD,
            authToken: 'live-token',
            tokenEnvironment: 'prod',
          },
        },
      ),
    ).toThrow(/production service/);
  });

  it('a token that names its environment is believed over the address', () => {
    const demoJwt = jwt({ iss: 'https://api.dev.easypos.al', deviceId: 'd' });
    expect(tokenClaimedEnvironment(demoJwt)).toBe('dev');
    expect(tokenClaimedEnvironment(jwt({ env: 'production' }))).toBe('prod');
    expect(tokenClaimedEnvironment(jwt({ deviceId: 'x' }))).toBeNull();
    expect(tokenClaimedEnvironment('not-a-jwt')).toBeNull();
    expect(() =>
      assertSettingsPatch(
        { fiscal: { baseUrl: PROD, authToken: demoJwt } },
        {},
      ),
    ).toThrow(/DEMO/);
  });

  it('other settings saves are untouched', () => {
    expect(
      assertSettingsPatch(
        { restaurantName: 'Bast' },
        { fiscal: { baseUrl: PROD, authToken: 't' } },
      ),
    ).toBeUndefined();
  });
});

describe('seller address for fiscal receipts', () => {
  it('turning fiscalization on needs the business address', () => {
    expect(() =>
      assertSettingsPatch({ fiscal: { enabled: true } }, { fiscal: {} }),
    ).toThrow(expect.objectContaining({ code: 'FISCAL_ADDRESS_REQUIRED' }));
  });

  it('with an address saved, or sent in the same save, it is fine', () => {
    expect(() =>
      assertSettingsPatch(
        { fiscal: { enabled: true } },
        { businessInfo: { address: 'Rr. Myslym Shyri 10, Tiranë' } },
      ),
    ).not.toThrow();
    expect(() =>
      assertSettingsPatch(
        {
          fiscal: { enabled: true },
          businessInfo: { address: 'Rr. Myslym Shyri 10' },
        },
        {},
      ),
    ).not.toThrow();
  });

  it('a venue already fiscalising keeps saving its settings', () => {
    expect(() =>
      assertSettingsPatch(
        { fiscal: { enabled: true, defaultSoldIn: 'XPP' } },
        { fiscal: { enabled: true } },
      ),
    ).not.toThrow();
  });
});
