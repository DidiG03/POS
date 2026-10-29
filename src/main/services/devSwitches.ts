/**
 * Environment switches that only a developer may use.
 *
 * `POS_LICENSE_BYPASS=1` skipped the licence check and `POS_VAULT=0` skipped
 * the till's encryption in the packaged release too: anyone able to start
 * the app with an environment variable (a shortcut, a launch script) ran an
 * unlicensed till with a plaintext ledger. A packaged build now ignores both;
 * there the licence is always checked and encryption is off only when the
 * owner turned Disk protection off in Admin.
 *
 * Free of Electron imports: `entry.ts` calls it before the app loads, and
 * tests call it directly.
 */

/** True when `POS_LICENSE_BYPASS=1` may skip the licence check. */
export function licenseBypassAllowed(
  envValue: string | undefined,
  packaged: boolean,
): boolean {
  if (packaged) return false;
  return String(envValue || '').trim() === '1';
}

/**
 * The POS_VAULT value the app should run with. Packaged: on, unless the
 * owner's Disk-protection-off marker exists (`vault/protectionOff.ts`);
 * whatever the environment said is ignored. Development: the environment
 * value as given (plaintext unless POS_VAULT=1).
 */
export function effectiveVaultFlag(input: {
  packaged: boolean;
  envValue: string | undefined;
  protectionOff: boolean;
}): string | undefined {
  if (!input.packaged) return input.envValue;
  return input.protectionOff ? '0' : '1';
}
