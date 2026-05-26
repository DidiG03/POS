import type { SettingsDTO } from '@shared/ipc';
import type { TicketPrintPayload } from '../../print';
import { buildEasyPosInvoiceDraft } from './mapInvoice';
import {
  assertFiscalConfigured,
  createEasyPosSale,
  testEasyPosConnection,
} from './easypos';

export {
  testEasyPosConnection,
  getFiscalTokenHint,
  testMinimalCloudInvoice,
} from './easypos';

export function isFiscalEnabled(settings: SettingsDTO): boolean {
  return (settings as any)?.fiscal?.enabled === true;
}

export async function maybeFiscalizePayment(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  options?: { idempotencyKey?: string },
): Promise<TicketPrintPayload> {
  const kind = String(payload.meta?.kind || '').toUpperCase();
  if (kind !== 'PAYMENT' || !isFiscalEnabled(settings)) {
    return payload;
  }

  assertFiscalConfigured(settings);

  const provider = String(
    (settings as any)?.fiscal?.provider || 'easypos',
  ).toLowerCase();
  if (provider !== 'easypos') {
    throw new Error(`Unsupported fiscal provider: ${provider}`);
  }

  const draft = buildEasyPosInvoiceDraft(payload, settings, {
    docId: String(options?.idempotencyKey || '').trim() || undefined,
  });
  const result = await createEasyPosSale(settings, draft);

  return {
    ...payload,
    meta: {
      ...(payload.meta || {}),
      fiscalEnabled: true,
      fiscalNslf: result.nslf || undefined,
      fiscalNivf: result.nivf || undefined,
      fiscalLink: result.link || undefined,
      fiscalWarning: result.warning || undefined,
      fiscalStatus: result.status,
    },
  };
}

export async function testFiscalConnection(
  settings: SettingsDTO,
): Promise<{ ok: boolean; message?: string; messageKey?: string }> {
  if (!isFiscalEnabled(settings)) {
    return { ok: false, message: 'Fiskalizimi is disabled.' };
  }
  const provider = String(
    (settings as any)?.fiscal?.provider || 'easypos',
  ).toLowerCase();
  if (provider === 'easypos') {
    return testEasyPosConnection(settings);
  }
  return { ok: false, message: `Unsupported fiscal provider: ${provider}` };
}
