/**
 * QA F6: the token went to any URL that merely contained an easyPos host
 * name. The host is now parsed and matched exactly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./transport', () => ({
  easyPosFetch: (url: string, init: unknown) =>
    (globalThis as any).fetch(url, init),
  warmEasyPosConnection: async () => undefined,
}));
import type { SettingsDTO } from '@shared/ipc';
import {
  assertFiscalConfigured,
  fiscalConfig,
  fiscalEnvironmentOf,
  isEasyPosCloudApi,
} from './config';
import { postInvoiceStatus } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('easyPos Cloud host matching', () => {
  it.each([
    ['https://api.dev.easypos.al/fiscalisation-service/v1', 'dev'],
    ['https://api.easypos.al/fiscalisation-service/v1', 'prod'],
    ['https://API.EASYPOS.AL/fiscalisation-service/v1/', 'prod'],
    ['https://api.easypos.al:443/fiscalisation-service/v1', 'prod'],
  ])('%s is %s', (url, env) => {
    expect(isEasyPosCloudApi(url)).toBe(true);
    expect(fiscalEnvironmentOf(url)).toBe(env);
  });

  it.each([
    'https://api.dev.easypos.al.attacker.com/fiscalisation-service/v1',
    'https://attacker.com/api.dev.easypos.al/v1',
    'https://attacker.com/?h=api.easypos.al',
    'https://api.dev.easypos.al@attacker.com/v1',
    'https://user:pw@api.easypos.al/v1',
    'https://notapi.easypos.al/v1',
    'http://api.easypos.al/v1',
    'https://api.easypos.al:8443/v1',
    'not a url',
    '',
  ])('%s is not easyPos Cloud', (url) => {
    expect(isEasyPosCloudApi(url)).toBe(false);
    expect(fiscalEnvironmentOf(url)).toBe('local');
  });

  it('keeps a real local middleware working', () => {
    const local = {
      fiscal: {
        provider: 'easypos',
        baseUrl: 'http://192.168.1.20:8080',
        authToken: 'local-token',
      },
    } as unknown as SettingsDTO;
    expect(fiscalConfig(local).cloud).toBe(false);
    expect(() => assertFiscalConfigured(local)).not.toThrow();
  });

  it('never sends the token to a lookalike host', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const lookalike = {
      fiscal: {
        provider: 'easypos',
        baseUrl:
          'https://api.dev.easypos.al.attacker.com/fiscalisation-service/v1',
        authToken: 'secret-jwt',
        integrationApp: 'generic',
        defaultOperatorId: 'gh537ez280',
      },
    } as unknown as SettingsDTO;
    await expect(
      postInvoiceStatus(lookalike, { docId: 'inv-x' }),
    ).rejects.toThrow(/not an easyPos Cloud address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
