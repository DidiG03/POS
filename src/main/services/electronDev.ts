/**
 * Packaged Electron does not reliably set NODE_ENV. Treat an installed
 * app as production unless ELECTRON_IS_DEV=1 (same rule as auto-update).
 */
export function isUnpackagedElectron(
  isPackaged: boolean,
  electronIsDev = process.env.ELECTRON_IS_DEV,
): boolean {
  return !isPackaged || electronIsDev === '1';
}
