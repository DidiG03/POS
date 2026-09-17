import { tableAreasFromDb } from './tableAreasSync';

/** Shape the live settings blob the way every client (IPC and LAN) reads it. */
export async function presentSettingsForClient(
  base: Record<string, any>,
  opts: { includePairingCode?: boolean } = {},
): Promise<Record<string, any>> {
  const result: any = {
    ...base,
    tableAreas: await tableAreasFromDb(base.tableAreas),
  };
  if (result?.security && typeof result.security === 'object') {
    result.security = { ...result.security };
    delete result.security.apiSecret;
    if (!opts.includePairingCode) delete result.security.pairingCode;
  }
  if (result?.fiscal && typeof result.fiscal === 'object') {
    result.fiscal = { ...result.fiscal };
    if (result.fiscal.authToken) {
      result.fiscal.authTokenConfigured = true;
      delete result.fiscal.authToken;
    }
  }
  return result;
}
