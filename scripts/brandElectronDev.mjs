/**
 * Chrome/macOS protocol prompts use the Electron binary's Info.plist name.
 * In `npm run dev` that binary is stock "Electron" — brand it so
 * codeorbit-pos:// offers "Open Code Orbit POS" instead of "Open Electron".
 * Packaged builds already use productName from electron-builder.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = 'Code Orbit POS';

if (process.platform !== 'darwin') process.exit(0);

const require = createRequire(import.meta.url);
let electronBin;
try {
  electronBin = require('electron');
} catch {
  process.exit(0);
}

const appBundle = path.resolve(String(electronBin), '../../..');
const plist = path.join(appBundle, 'Contents', 'Info.plist');
if (!appBundle.endsWith('.app') || !fs.existsSync(plist)) process.exit(0);

function setPlistString(key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, plist], {
    stdio: 'ignore',
  });
}

try {
  setPlistString('CFBundleName', APP_NAME);
  setPlistString('CFBundleDisplayName', APP_NAME);
} catch {
  process.exit(0);
}

const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
if (fs.existsSync(lsregister)) {
  try {
    execFileSync(lsregister, ['-f', appBundle], { stdio: 'ignore' });
  } catch {
    // Launch Services refresh is best-effort
  }
}
