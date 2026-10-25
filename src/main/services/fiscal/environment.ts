/**
 * Keeping test and live fiskalizimi apart.
 *
 * A till is usually tried on the easyPos test service before it goes live.
 * Anything still queued from then (an invoice taken offline, a refund
 * waiting to be resent) used to be sent to whatever service the settings
 * pointed at when the loop next ran — so switching to live filed sandbox
 * sales with the tax authority. Queued work now carries the environment it
 * was made for and is only ever sent there.
 */

import { prisma } from '@db/client';
import type { FiscalEnvironment } from './config';

const CLAIM_PREFIX = 'fiscal:claim:';
const CORRECTION_PREFIX = 'fiscal:correction-retry:';

/** True when work made for `made` may be sent while on `current`. */
export function sameFiscalEnvironment(
  made: string | undefined | null,
  current: FiscalEnvironment,
): boolean {
  // Untagged work predates this check and belongs to the service in use.
  return !made || made === current;
}

/**
 * Test-service work found while on another service: it never needs to reach
 * the tax authority, so it is dropped rather than kept waiting.
 */
export function isLeftoverTestWork(
  made: string | undefined | null,
  current: FiscalEnvironment,
): boolean {
  return made === 'dev' && current !== 'dev';
}

function parse(raw: unknown): any {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The service is about to change: stamp everything not yet tagged with the
 * environment it was made on, so it stays there. Runs once per switch.
 */
export async function tagUntaggedFiscalWork(
  environment: FiscalEnvironment,
): Promise<number> {
  let tagged = 0;
  const rows = (await prisma.syncState
    .findMany({
      where: {
        OR: [
          { key: { startsWith: CLAIM_PREFIX } },
          { key: { startsWith: CORRECTION_PREFIX } },
        ],
      },
    })
    .catch(() => [])) as Array<{ key: string; valueJson: unknown }>;
  for (const row of rows) {
    const value = parse(row.valueJson);
    if (!value || typeof value !== 'object') continue;
    let next: any = null;
    if (row.key.startsWith(CLAIM_PREFIX)) {
      if (value.context?.environment) continue;
      next = { ...value, context: { ...(value.context || {}), environment } };
    } else {
      if (value.environment) continue;
      next = { ...value, environment };
    }
    await prisma.syncState
      .update({ where: { key: row.key }, data: { valueJson: next } })
      .then(() => {
        tagged += 1;
      })
      .catch(() => undefined);
  }
  return tagged;
}
